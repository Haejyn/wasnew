/**
 * MCP server over stdio — gives an agent safe verbs for files: snapshot, move (journaled),
 * undo, restore (guarded), diff, read-as-it-was. Hand-rolled JSON-RPC so the package keeps zero
 * dependencies; messages are newline-delimited per the MCP stdio transport.
 */
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { openVault, type Actor, type Diff, type ManyResult, type PlanOp, type UndoResult, type Vault, type WhereResult } from "./index.js";
import { WasnewError, isWasnewError } from "./errors.js";
import { summarizeOps, type SummaryOp } from "./summary.js";

export const VERSION = "0.3.0";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_READ_BYTES = 200_000;
/** A result list longer than this is cut to its first KEEP items unless the call asks for `full` */
const CUT_OVER = 50;
const KEEP = 20;
/** Failure codes that mean "no such path": the journal may know where it went */
const MISSING = new Set(["ENOENT", "NOT_FOUND", "NOT_IN_SNAPSHOT"]);

const INSTRUCTIONS = `wasnew keeps an undoable history of a folder. Use these tools instead of mv, rm or overwriting files directly:
- Call wasnew_snapshot before changing many files.
- Move or rename with wasnew_move; to delete, use wasnew_trash (it can be undone). Pass one batch id per task so the user can undo the whole task with wasnew_undo, and say why in "reason".
- For larger changes, propose them with wasnew_plan and show the user the plan. If it needs approval, the user approves it themselves (\`wasnew approve <id>\`); then call wasnew_apply.
- wasnew_restore brings files back to a snapshot and first saves what it overwrites, so it can be undone too.
- Errors carry a code (DEST_EXISTS, POLICY_PROTECTED, NEEDS_APPROVAL, ...). Read it, fix the input or ask the user, then retry.
- Read \`summary\` first: it groups similar changes into a few lines. Lists over ${CUT_OVER} items are cut to ${KEEP} unless you pass full: true.`;

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  run(vault: Vault, args: any, ctx: Context): Promise<{ result: unknown; text?: string }>;
}
interface Context { root: string; allowOutsideSources: boolean; client?: string }

const str = (description: string) => ({ type: "string", description });
const int = (description: string, minimum = 1) => ({ type: "integer", minimum, description });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const reason = str("Why, in one short sentence the user will see in the history");
const full = { type: "boolean", description: `Return every item; by default a list over ${CUT_OVER} items is cut to the first ${KEEP} and \`summary\` describes all of them` };

/** The connected client is the agent; the model may name itself and give a reason per call */
function actor(ctx: Context, a: { reason?: string; model?: string }): Actor | undefined {
  const by: Actor = { ...(ctx.client ? { agent: ctx.client } : {}), ...(a.model ? { model: a.model } : {}), ...(a.reason ? { reason: a.reason } : {}) };
  return Object.keys(by).length ? by : undefined;
}

/** Many operations at once go through a plan when the folder's policy asks for a person's approval */
async function gate(v: Vault, n: number): Promise<void> {
  const limit = (await v.policy()).policy.requireApprovalOver;
  if (limit !== undefined && n > limit) {
    throw new WasnewError("NEEDS_APPROVAL", `${n} operations is more than this folder allows without approval (${limit}); propose them with wasnew_plan and ask the user to approve`);
  }
}

/**
 * The tools report every failure and carry on with the rest, while moveMany and trashMany stop at
 * the first one. Runs the list in stretches, restarting after each failure. Returns how many were done.
 */
async function keepGoing<T>(
  list: T[],
  many: (items: T[]) => Promise<ManyResult>,
  onFail: (item: T, code: string, message: string, index: number) => void,
  refuse: (item: T) => WasnewError | undefined = () => undefined,
): Promise<number> {
  let done = 0;
  let i = 0;
  while (i < list.length) {
    const refused = refuse(list[i]);
    if (refused) {
      onFail(list[i], refused.code, refused.message, i);
      i++;
      continue;
    }
    let end = i + 1;
    while (end < list.length && !refuse(list[end])) end++;
    const r = await many(list.slice(i, end));
    done += r.done;
    if (r.failed) onFail(list[i + r.failed.index], r.failed.code, r.failed.message, i + r.failed.index);
    i += r.failed ? r.failed.index + 1 : end - i;
  }
  return done;
}

function newBatchId(): string {
  return "mcp-" + new Date().toISOString().replaceAll(/[-:.]/g, "").replace("T", "-").replace("Z", "") + "-" + randomBytes(2).toString("hex");
}

const cutList = <T>(list: T[], all: boolean): T[] => (!all && list.length > CUT_OVER ? list.slice(0, KEEP) : list);

/** How many failures of each code; kept even when the list itself is cut */
function byCode<T>(list: T[], code: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of list) out[code(t)] = (out[code(t)] ?? 0) + 1;
  return out;
}

/** What to tell an agent whose path is gone, from where() */
function forwardNote(w: WhereResult): { note: string; movedTo?: string; trashedTo?: string } | undefined {
  const by = w.by?.agent ?? w.by?.model;
  const tail = `${by ? ` by ${by}` : ""}${w.at ? ` at ${w.at.slice(0, 16)}Z` : ""}${w.batch ? ` (batch ${w.batch})` : ""}`;
  if (w.status === "moved") return { note: `; moved to ${w.current}${tail}, use that path`, movedTo: w.current };
  if (w.status === "trashed") return { note: `; trashed${tail}, wasnew_undo${w.batch ? " of that batch" : ""} brings it back`, trashedTo: w.current };
  if (w.status === "purged") return { note: `; it was trashed${tail} and the trash has since been emptied` };
  return undefined;
}

/** Adds where-it-went to failures whose path does not exist, with one journal read for all of them */
async function forwardFailures<T extends { message: string }>(v: Vault, list: T[], code: (t: T) => string, pathOf: (t: T) => string | undefined): Promise<T[]> {
  const idx = list.flatMap((t, i) => (MISSING.has(code(t)) && pathOf(t) !== undefined ? [i] : []));
  if (!idx.length) return list;
  const found = await v.whereMany(idx.map((i) => pathOf(list[i])!));
  const out = [...list];
  idx.forEach((i, k) => {
    const f = forwardNote(found[k]);
    if (f) out[i] = { ...out[i], message: out[i].message + f.note, ...(f.movedTo ? { movedTo: f.movedTo } : {}), ...(f.trashedTo ? { trashedTo: f.trashedTo } : {}) };
  });
  return out;
}

/**
 * A failure list as results carry it: cut like any list, counted by code in `<key>ByCode` so no
 * failure kind is ever hidden, and forwarded where a path moved.
 */
async function failures<T extends { code: string; message: string }>(v: Vault, key: string, list: T[], all: boolean, pathOf: (t: T) => string | undefined): Promise<Record<string, unknown>> {
  const shown = await forwardFailures(v, cutList(list, all), (t) => t.code, pathOf);
  return { [key]: shown, ...(list.length ? { [key + "ByCode"]: byCode(list, (t) => t.code) } : {}) };
}

const cutInfo = (shown: number, total: number) => (shown < total ? { truncated: true, total } : {});

export function formatWhere(w: WhereResult): string {
  const head = w.status === "here" ? `${w.path} is there now`
    : w.status === "moved" ? `${w.path} moved to ${w.current}`
    : w.status === "trashed" ? `${w.path} is in the trash at ${w.current}; undo ${w.batch ? `batch ${w.batch}` : "it"} to bring it back`
    : w.status === "purged" ? `${w.path} was trashed and the trash was emptied`
    : w.missing ? `${w.path} was last recorded at ${w.current}, but nothing is there now`
    : `nothing recorded about ${w.path}`;
  const steps = w.steps.map((s) => { const by = s.by?.agent ?? s.by?.model; return `  ${s.at}  ${s.op.padEnd(5)} ${s.from}${s.to !== undefined ? ` -> ${s.to}` : ""}${by ? `  by ${by}` : ""}${s.batch ? `  [${s.batch}]` : ""}`; });
  return [head, ...steps].join("\n");
}

const undoOps = (list: { from: string; to: string; trashed?: true }[]): SummaryOp[] => list.map((r) => ({ op: "undo", from: r.to, to: r.from, ...(r.trashed ? { trashed: true } : {}) }));
const recordOps = (list: { from: string; to: string; trashed?: true }[]): SummaryOp[] => list.map((r) => (r.trashed ? { op: "trash", from: r.from } : { op: "move", from: r.from, to: r.to }));
const planOps = (ops: PlanOp[]): SummaryOp[] => ops.map((o) => (o.op === "move" ? { op: "move", from: o.from, to: o.to } : { op: "trash", from: o.path }));

/** wasnew_undo's result: summary of everything undone, lists cut unless `all` */
export function undoResult(r: UndoResult, all: boolean) {
  const undone = cutList(r.undone, all);
  const skipped = cutList(r.skipped, all);
  return {
    summary: summarizeOps(undoOps(r.undone)).lines,
    undone,
    skipped,
    ...(r.skipped.length ? { skippedByCode: byCode(r.skipped, (s) => s.reason) } : {}),
    ...cutInfo(undone.length + skipped.length, r.undone.length + r.skipped.length),
  };
}

export function formatDiff(d: Diff, limit = 50): string {
  const lines = [
    ...d.added.map((p) => `+ ${p}`),
    ...d.changed.map((p) => `~ ${p}`),
    ...d.missing.map((p) => `- ${p}`),
    ...d.moved.map((m) => `> ${m.from} -> ${m.to}`),
  ];
  const head = `${d.added.length} added, ${d.changed.length} changed, ${d.missing.length} missing, ${d.moved.length} moved`;
  if (!lines.length) return head;
  const more = lines.length > limit ? `\n… ${lines.length - limit} more` : "";
  return head + "\n" + lines.slice(0, limit).join("\n") + more;
}

const TOOLS: Tool[] = [
  {
    name: "wasnew_snapshot",
    title: "Snapshot the folder",
    description: "Save the current content of every file in the folder so it can be restored later. Call before a task that changes many files.",
    inputSchema: { type: "object", properties: { label: str("What is about to happen, e.g. 'before sorting Downloads'") }, additionalProperties: false },
    annotations: WRITES,
    async run(v, a) { return { result: await v.snapshot({ label: a.label }) }; },
  },
  {
    name: "wasnew_log",
    title: "List snapshots",
    description: "List snapshots, newest first.",
    inputSchema: { type: "object", properties: { limit: int("How many to return (default 20)") }, additionalProperties: false },
    annotations: READ_ONLY,
    async run(v, a) { return { result: { snapshots: (await v.log()).slice(0, a.limit ?? 20) } }; },
  },
  {
    name: "wasnew_diff",
    title: "Compare with a snapshot",
    description: "What changed since a snapshot (or between two): added, changed, missing and moved files. Use it to explain to the user what a task did.",
    inputSchema: { type: "object", properties: { from: str("Snapshot id to compare from"), to: str("Snapshot id to compare to; omit for the current files"), full }, required: ["from"], additionalProperties: false },
    annotations: READ_ONLY,
    async run(v, a) {
      const d = await v.diff(a.from, a.to);
      const moved = summarizeOps(d.moved.map((m) => ({ op: "move", from: m.from, to: m.to }))).lines;
      const [head, ...body] = formatDiff(d).split("\n");
      const cut = { added: cutList(d.added, !!a.full), changed: cutList(d.changed, !!a.full), missing: cutList(d.missing, !!a.full), moved: cutList(d.moved, !!a.full) };
      const shown = cut.added.length + cut.changed.length + cut.missing.length + cut.moved.length;
      const total = d.added.length + d.changed.length + d.missing.length + d.moved.length;
      return { result: { summary: [head, ...moved], ...cut, ...cutInfo(shown, total) }, text: [head, ...moved.map((l) => "  " + l), ...body].join("\n") };
    },
  },
  {
    name: "wasnew_move",
    title: "Move or rename files (undoable)",
    description: "Move or rename files and folders inside the folder, recorded in the journal with who and why. Never overwrites: an existing destination fails with DEST_EXISTS. Use one batch id per task; the result returns it.",
    inputSchema: {
      type: "object",
      properties: {
        moves: {
          type: "array", minItems: 1, maxItems: 5000,
          items: { type: "object", properties: { from: str("Current path, relative to the folder"), to: str("New path, relative to the folder") }, required: ["from", "to"], additionalProperties: false },
        },
        batch: str("Batch id grouping this task's moves; omit to get a new one"),
        reason,
        model: str("Your model name, recorded with the change"),
        full,
      },
      required: ["moves"],
      additionalProperties: false,
    },
    annotations: WRITES,
    async run(v, a, ctx) {
      await gate(v, a.moves.length);
      const batch: string = a.batch ?? newBatchId();
      const by = actor(ctx, a);
      const failed: { from: string; to: string; code: string; message: string }[] = [];
      const bad = new Set<number>();
      const outside = (m: { from: string }) => {
        const abs = path.resolve(ctx.root, m.from);
        if (ctx.allowOutsideSources || abs === ctx.root || abs.startsWith(ctx.root + path.sep)) return undefined;
        return new WasnewError("OUTSIDE_ROOT", "source is outside the folder: " + m.from, m.from);
      };
      const list = a.moves as { from: string; to: string }[];
      const moved = await keepGoing(list, (l) => v.moveMany(l, batch, by), (m, code, message, i) => { bad.add(i); failed.push({ ...m, code, message }); }, outside);
      const summary = summarizeOps(list.filter((_, i) => !bad.has(i))).lines;
      const f = await failures(v, "failed", failed, !!a.full, (x) => x.from);
      return { result: { summary, batch, moved, ...f, ...cutInfo((f.failed as unknown[]).length, failed.length) } };
    },
  },
  {
    name: "wasnew_trash",
    title: "Trash files (undoable)",
    description: "The way to delete: sets files or folders aside in the folder's trash instead of removing them. wasnew_undo puts them back; only the user can empty the trash.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", minItems: 1, maxItems: 5000, items: { type: "string" }, description: "Paths relative to the folder" },
        batch: str("Batch id grouping this task's changes; omit to get a new one"),
        reason,
        model: str("Your model name, recorded with the change"),
        full,
      },
      required: ["paths"],
      additionalProperties: false,
    },
    annotations: WRITES,
    async run(v, a, ctx) {
      await gate(v, a.paths.length);
      const batch: string = a.batch ?? newBatchId();
      const by = actor(ctx, a);
      const failed: { path: string; code: string; message: string }[] = [];
      const bad = new Set<number>();
      const list = a.paths as string[];
      const trashed = await keepGoing(list, (l) => v.trashMany(l, batch, by), (p, code, message, i) => { bad.add(i); failed.push({ path: p, code, message }); });
      const summary = summarizeOps(list.filter((_, i) => !bad.has(i)).map((p) => ({ op: "trash", from: p }))).lines;
      const f = await failures(v, "failed", failed, !!a.full, (x) => x.path);
      return { result: { summary, batch, trashed, ...f, ...cutInfo((f.failed as unknown[]).length, failed.length) } };
    },
  },
  {
    name: "wasnew_plan",
    title: "Propose changes",
    description: "Check a list of moves and trashes against the folder without doing anything. Returns a plan id, any issues per operation, and whether the user must approve it first. Show the plan to the user, then call wasnew_apply.",
    inputSchema: {
      type: "object",
      properties: {
        ops: {
          type: "array", minItems: 1, maxItems: 5000,
          items: {
            type: "object",
            properties: { op: { type: "string", enum: ["move", "trash"] }, from: str("move: current path"), to: str("move: new path"), path: str("trash: path") },
            required: ["op"],
            additionalProperties: false,
          },
        },
        reason,
        model: str("Your model name, recorded with the plan"),
        full,
      },
      required: ["ops"],
      additionalProperties: false,
    },
    annotations: WRITES,
    async run(v, a, ctx) {
      for (const op of a.ops as PlanOp[]) {
        if (op.op === "move" && !ctx.allowOutsideSources) {
          const abs = path.resolve(ctx.root, op.from ?? "");
          if (abs !== ctx.root && !abs.startsWith(ctx.root + path.sep)) throw new WasnewError("OUTSIDE_ROOT", "source is outside the folder: " + op.from, op.from);
        }
      }
      const plan = await v.plan(a.ops, { by: actor(ctx, a) });
      const summary = summarizeOps(planOps(plan.ops)).lines;
      const source = (i: { index: number }) => { const op = plan.ops[i.index]; return op?.op === "move" ? op.from : op?.path; };
      const f = await failures(v, "issues", plan.issues, !!a.full, source);
      const issues = f.issues as typeof plan.issues;
      const text = [
        `plan ${plan.id}: ${plan.ops.length} operations, ${plan.issues.length} issues${plan.needsApproval ? `, needs the user's approval (wasnew approve ${plan.id})` : ""}`,
        ...summary.map((l) => "  " + l),
        ...issues.map((i) => `  #${i.index} ${i.code}: ${i.message}`),
        ...(issues.length < plan.issues.length ? [`  … ${plan.issues.length - issues.length} more issues`] : []),
      ].join("\n");
      return { result: { summary, id: plan.id, ops: plan.ops.length, ...f, needsApproval: plan.needsApproval, ...cutInfo(issues.length, plan.issues.length) }, text };
    },
  },
  {
    name: "wasnew_apply",
    title: "Apply a plan",
    description: "Run exactly the operations of a plan, once, as one undoable batch. Refuses with NEEDS_APPROVAL until the user approved a plan that needs it, and with PLAN_INVALID if the folder changed since.",
    inputSchema: { type: "object", properties: { plan: str("Plan id from wasnew_plan") }, required: ["plan"], additionalProperties: false },
    annotations: WRITES,
    async run(v, a) {
      const r = await v.apply(a.plan);
      const done = (await v.getPlan(a.plan)).ops.slice(0, r.done);
      return { result: { summary: summarizeOps(planOps(done)).lines, ...r } };
    },
  },
  {
    name: "wasnew_history",
    title: "History of a file",
    description: "Everything recorded about a path and the names it had: moves, trashes, undos and restores, with when, by whom and why.",
    inputSchema: { type: "object", properties: { path: str("Path relative to the folder, current or former") }, required: ["path"], additionalProperties: false },
    annotations: READ_ONLY,
    async run(v, a) {
      const events = await v.history(a.path);
      const w = await v.where(a.path);   // a gone path gets where it went, as a failed call would
      return { result: { events, ...(w.status === "moved" ? { movedTo: w.current } : {}) } };
    },
  },
  {
    name: "wasnew_where",
    title: "Where a file is now",
    description: "Where a path's file is now, following moves, folder moves, trash and undo in the journal. Call it when a path you knew no longer exists.",
    inputSchema: { type: "object", properties: { path: str("Path relative to the folder, as you last knew it") }, required: ["path"], additionalProperties: false },
    annotations: READ_ONLY,
    async run(v, a) { const w = await v.where(a.path); return { result: w, text: formatWhere(w) }; },
  },
  {
    name: "wasnew_pending",
    title: "Moves that can still be undone",
    description: "List journaled moves not yet undone, newest first, optionally for one batch.",
    inputSchema: { type: "object", properties: { batch: str("Only this batch"), limit: int("How many to return (default 50)"), full }, additionalProperties: false },
    annotations: READ_ONLY,
    async run(v, a) {
      const all = await v.pendingMoves(a.batch);
      const moves = cutList(all.slice(0, a.limit ?? 50), !!a.full);
      return { result: { summary: summarizeOps(recordOps(all)).lines, total: all.length, moves, ...(moves.length < all.length ? { truncated: true } : {}) } };
    },
  },
  {
    name: "wasnew_undo",
    title: "Undo moves",
    description: "Undo the moves and trashes of a batch (all of it, or only its last `count`), or the last `count` overall. Never overwrites: if something now sits at the original place, that one is skipped and reported with a reason.",
    inputSchema: { type: "object", properties: { batch: str("Batch to undo"), count: int("How many of the newest moves to undo"), reason, full }, additionalProperties: false },
    annotations: WRITES,
    async run(v, a, ctx) { return { result: undoResult(await v.undo({ batch: a.batch, count: a.count, by: actor(ctx, a) }), !!a.full) }; },
  },
  {
    name: "wasnew_restore",
    title: "Restore from a snapshot",
    description: "Bring files back to their content in a snapshot (all, or only `paths`). Files the snapshot doesn't have are left alone. What gets overwritten is saved first; the result's `guard` is that snapshot, restorable the same way.",
    inputSchema: { type: "object", properties: { snapshot: str("Snapshot id"), paths: { type: "array", items: { type: "string" }, description: "Only these paths (relative to the folder)" }, reason }, required: ["snapshot"], additionalProperties: false },
    annotations: WRITES,
    async run(v, a, ctx) { return { result: await v.restore(a.snapshot, { paths: a.paths, by: actor(ctx, a) }) }; },
  },
  {
    name: "wasnew_read",
    title: "Read a file as it was",
    description: "Read a file's content as it was in a snapshot, without touching the current file.",
    inputSchema: { type: "object", properties: { snapshot: str("Snapshot id"), path: str("Path relative to the folder") }, required: ["snapshot", "path"], additionalProperties: false },
    annotations: READ_ONLY,
    async run(v, a) {
      const bytes = Buffer.from(await v.readSnapshotFile(a.snapshot, a.path));
      if (bytes.subarray(0, 8192).includes(0)) return { result: { path: a.path, size: bytes.length, binary: true }, text: `binary file, ${bytes.length} bytes` };
      const truncated = bytes.length > MAX_READ_BYTES;
      const text = bytes.subarray(0, MAX_READ_BYTES).toString("utf8");
      return { result: { path: a.path, size: bytes.length, truncated }, text: truncated ? text + `\n… truncated at ${MAX_READ_BYTES} of ${bytes.length} bytes` : text };
    },
  },
];

type Json = Record<string, any>;

export async function serveMcp(opts: { root: string; input: Readable; output: Writable; allowOutsideSources?: boolean }): Promise<void> {
  const ctx: Context = { root: path.resolve(opts.root), allowOutsideSources: !!opts.allowOutsideSources };
  const vault = await openVault(ctx.root);
  const send = (msg: Json) => { opts.output.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n"); };
  const fail = (id: unknown, code: number, message: string) => send({ id, error: { code, message } });

  async function handle(msg: Json): Promise<void> {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    if (!isRequest) return;   // notifications (initialized, cancelled) need no answer
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        const info = params?.clientInfo;
        if (typeof info?.name === "string") ctx.client = [info.name, info.version].filter((x) => typeof x === "string").join(" ").slice(0, 100);
        return send({ id, result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "wasnew", title: "wasnew", version: VERSION },
          instructions: INSTRUCTIONS,
        } });
      }
      case "ping":
        return send({ id, result: {} });
      case "tools/list":
        return send({ id, result: { tools: TOOLS.map(({ run: _run, ...t }) => t) } });
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return fail(id, -32602, "unknown tool: " + params?.name);
        try {
          const { result, text } = await tool.run(vault, params.arguments ?? {}, ctx);
          return send({ id, result: { content: [{ type: "text", text: text ?? JSON.stringify(result, null, 1) }], structuredContent: result, isError: false } });
        } catch (e: any) {
          // a tool failure is a result the model can read and act on, not a protocol error
          let error: { code: string; message: string } = { code: isWasnewError(e) ? e.code : e?.code ?? "ERROR", message: String(e?.message ?? e) };
          // a path that is gone may have moved: say where, like the failed entries of move and trash do
          const gone = (isWasnewError(e) ? e.path : undefined) ?? params.arguments?.path;
          if (typeof gone === "string") [error] = await forwardFailures(vault, [error], (x) => x.code, () => gone).catch(() => [error]);
          return send({ id, result: { content: [{ type: "text", text: `${error.code}: ${error.message}` }], structuredContent: { error }, isError: true } });
        }
      }
      default:
        return fail(id, -32601, "method not found: " + method);
    }
  }

  // one at a time, in order — file operations must not interleave
  let chain = Promise.resolve();
  const lines = createInterface({ input: opts.input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(null, -32700, "parse error");
      continue;
    }
    chain = chain.then(() => handle(msg)).catch((e) => fail(msg.id ?? null, -32603, String(e?.message ?? e)));
  }
  await chain;
}
