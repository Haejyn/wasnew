/**
 * MCP server over stdio — gives an agent safe verbs for files: snapshot, move (journaled),
 * undo, restore (guarded), diff, read-as-it-was. Hand-rolled JSON-RPC so the package keeps zero
 * dependencies; messages are newline-delimited per the MCP stdio transport.
 */
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { openVault, type Actor, type Diff, type PlanOp, type Vault } from "./index.js";
import { WasnewError, isWasnewError } from "./errors.js";

export const VERSION = "0.3.0";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_READ_BYTES = 200_000;

const INSTRUCTIONS = `wasnew keeps an undoable history of a folder. Use these tools instead of mv, rm or overwriting files directly:
- Call wasnew_snapshot before changing many files.
- Move or rename with wasnew_move; to delete, use wasnew_trash (it can be undone). Pass one batch id per task so the user can undo the whole task with wasnew_undo, and say why in "reason".
- For larger changes, propose them with wasnew_plan and show the user the plan. If it needs approval, the user approves it themselves (\`wasnew approve <id>\`); then call wasnew_apply.
- wasnew_restore brings files back to a snapshot and first saves what it overwrites, so it can be undone too.
- Errors carry a code (DEST_EXISTS, POLICY_PROTECTED, NEEDS_APPROVAL, ...) — read it, fix the input or ask the user, then retry.`;

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

const reason = str("Why — one short sentence the user will see in the history");

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

function newBatchId(): string {
  return "mcp-" + new Date().toISOString().replaceAll(/[-:.]/g, "").replace("T", "-").replace("Z", "") + "-" + randomBytes(2).toString("hex");
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
    inputSchema: { type: "object", properties: { from: str("Snapshot id to compare from"), to: str("Snapshot id to compare to; omit for the current files") }, required: ["from"], additionalProperties: false },
    annotations: READ_ONLY,
    async run(v, a) { const d = await v.diff(a.from, a.to); return { result: d, text: formatDiff(d) }; },
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
      },
      required: ["moves"],
      additionalProperties: false,
    },
    annotations: WRITES,
    async run(v, a, ctx) {
      await gate(v, a.moves.length);
      const batch: string = a.batch ?? newBatchId();
      const by = actor(ctx, a);
      const moved: { from: string; to: string }[] = [];
      const failed: { from: string; to: string; code: string; message: string }[] = [];
      for (const m of a.moves as { from: string; to: string }[]) {
        try {
          const abs = path.resolve(ctx.root, m.from);
          if (!ctx.allowOutsideSources && abs !== ctx.root && !abs.startsWith(ctx.root + path.sep)) {
            throw new WasnewError("OUTSIDE_ROOT", "source is outside the folder: " + m.from, m.from);
          }
          await v.move(m.from, m.to, batch, by);
          moved.push(m);
        } catch (e: any) {
          failed.push({ ...m, code: e?.code ?? "ERROR", message: String(e?.message ?? e) });
        }
      }
      return { result: { batch, moved: moved.length, failed } };
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
      },
      required: ["paths"],
      additionalProperties: false,
    },
    annotations: WRITES,
    async run(v, a, ctx) {
      await gate(v, a.paths.length);
      const batch: string = a.batch ?? newBatchId();
      const by = actor(ctx, a);
      const trashed: string[] = [];
      const failed: { path: string; code: string; message: string }[] = [];
      for (const p of a.paths as string[]) {
        try {
          await v.trash(p, batch, by);
          trashed.push(p);
        } catch (e: any) {
          failed.push({ path: p, code: e?.code ?? "ERROR", message: String(e?.message ?? e) });
        }
      }
      return { result: { batch, trashed: trashed.length, failed } };
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
      const text = [
        `plan ${plan.id}: ${plan.ops.length} operations, ${plan.issues.length} issues${plan.needsApproval ? `, needs the user's approval (wasnew approve ${plan.id})` : ""}`,
        ...plan.issues.map((i) => `  #${i.index} ${i.code}: ${i.message}`),
      ].join("\n");
      return { result: { id: plan.id, ops: plan.ops.length, issues: plan.issues, needsApproval: plan.needsApproval }, text };
    },
  },
  {
    name: "wasnew_apply",
    title: "Apply a plan",
    description: "Run exactly the operations of a plan, once, as one undoable batch. Refuses with NEEDS_APPROVAL until the user approved a plan that needs it, and with PLAN_INVALID if the folder changed since.",
    inputSchema: { type: "object", properties: { plan: str("Plan id from wasnew_plan") }, required: ["plan"], additionalProperties: false },
    annotations: WRITES,
    async run(v, a) { return { result: await v.apply(a.plan) }; },
  },
  {
    name: "wasnew_history",
    title: "History of a file",
    description: "Everything recorded about a path and the names it had: moves, trashes, undos, restores — when, by whom and why.",
    inputSchema: { type: "object", properties: { path: str("Path relative to the folder, current or former") }, required: ["path"], additionalProperties: false },
    annotations: READ_ONLY,
    async run(v, a) { return { result: { events: await v.history(a.path) } }; },
  },
  {
    name: "wasnew_pending",
    title: "Moves that can still be undone",
    description: "List journaled moves not yet undone, newest first, optionally for one batch.",
    inputSchema: { type: "object", properties: { batch: str("Only this batch"), limit: int("How many to return (default 50)") }, additionalProperties: false },
    annotations: READ_ONLY,
    async run(v, a) {
      const all = await v.pendingMoves(a.batch);
      return { result: { total: all.length, moves: all.slice(0, a.limit ?? 50) } };
    },
  },
  {
    name: "wasnew_undo",
    title: "Undo moves",
    description: "Undo the moves and trashes of a batch (all of it, or only its last `count`), or the last `count` overall. Never overwrites: if something now sits at the original place, that one is skipped and reported with a reason.",
    inputSchema: { type: "object", properties: { batch: str("Batch to undo"), count: int("How many of the newest moves to undo"), reason }, additionalProperties: false },
    annotations: WRITES,
    async run(v, a, ctx) { return { result: await v.undo({ batch: a.batch, count: a.count, by: actor(ctx, a) }) }; },
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
          const error = { code: isWasnewError(e) ? e.code : e?.code ?? "ERROR", message: String(e?.message ?? e) };
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
