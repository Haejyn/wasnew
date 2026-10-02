#!/usr/bin/env node
import { parseArgs } from "node:util";
import { openVault, isWasnewError, type Actor, type Plan } from "./index.js";
import { serveMcp, formatDiff, VERSION } from "./mcp.js";

const HELP = `wasnew ${VERSION} — undo for programs that touch your files

usage: wasnew <command> [options]

  mcp                         run the MCP server on stdio
      --allow-outside-sources   let agents move files in from outside the folder
  snapshot [-m label]         save the current content of every file
      --if-changed              skip it when nothing changed since the last one
      --rehash                  re-read every file instead of trusting size + mtime
  watch [--debounce ms]       snapshot whenever the folder changes (Ctrl+C to stop)
  log                         list snapshots, newest first
  diff <from> [to]            what changed since a snapshot (or between two)
  pending [--batch id]        moves that can still be undone
  undo [--batch id] [-n N]    undo a batch, or its / the journal's last N moves
  restore <id> [paths...]     restore files from a snapshot (saves what it overwrites)
  gc --keep-last N | --older-than-days D [--apply]
                              drop old snapshots from the store (dry run unless --apply)

  plans                       proposed plans, newest first
  show <plan>                 a plan's operations and issues
  approve <plan>              approve a plan an agent proposed (agents cannot do this)
  apply <plan>                run an approved plan as one undoable batch
  history <path>              who moved, trashed or restored a file, when and why
  recover                     settle operations a crashed process left half-recorded
  empty-trash --older-than-days D [--apply]
                              really delete trashed files (dry run unless --apply)
  policy                      show this folder's policy (.wasnew/policy.json)

common: --root <dir> (default: current folder)  --json  --help`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      message: { type: "string", short: "m" },
      batch: { type: "string" },
      count: { type: "string", short: "n" },
      "keep-last": { type: "string" },
      "older-than-days": { type: "string" },
      apply: { type: "boolean" },
      "allow-outside-sources": { type: "boolean" },
      by: { type: "string" },
      "if-changed": { type: "boolean" },
      rehash: { type: "boolean" },
      debounce: { type: "string" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.version) { console.log(VERSION); return 0; }
  if (values.help || !command) { console.log(HELP); return command || values.help ? 0 : 1; }
  const root = values.root ?? process.cwd();
  const num = (s: string | undefined) => (s === undefined ? undefined : Number(s));
  const out = (data: unknown, text: string) => console.log(values.json ? JSON.stringify(data, null, 1) : text);

  if (command === "mcp") {
    await serveMcp({ root, input: process.stdin, output: process.stdout, allowOutsideSources: values["allow-outside-sources"] });
    return 0;
  }
  const vault = await openVault(root);
  switch (command) {
    case "snapshot": {
      const s = await vault.snapshot({ label: values.message, skipIfUnchanged: values["if-changed"], rehash: values.rehash });
      out(s, s.unchanged ? `${s.id}  unchanged` : `${s.id}  ${s.fileCount} files, ${s.hashed ?? s.fileCount} read, ${s.newBlobs} new blobs`);
      return 0;
    }
    case "watch": {
      const ac = new AbortController();
      process.once("SIGINT", () => ac.abort());
      process.once("SIGTERM", () => ac.abort());
      const first = await vault.snapshot({ label: values.message ?? "watch", skipIfUnchanged: true });
      if (!values.json) console.error(`watching ${vault.root} — ${first.unchanged ? "up to date with" : "saved"} ${first.id}; Ctrl+C to stop`);
      await vault.watch({
        signal: ac.signal,
        debounceMs: num(values.debounce),
        label: values.message,
        onSnapshot: (s) => out(s, `${s.created}  ${s.id}  ${s.fileCount} files, ${s.hashed ?? s.fileCount} read`),
        onError: (e) => console.error(isWasnewError(e) ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e)),
      });
      return 0;
    }
    case "log": {
      const list = await vault.log();
      out(list, list.map((s) => `${s.id}  ${s.created}  ${String(s.fileCount).padStart(6)} files${s.partial ? " (partial)" : ""}  ${s.label ?? ""}`).join("\n") || "no snapshots");
      return 0;
    }
    case "diff": {
      if (!rest[0]) throw new Error("diff needs a snapshot id");
      const d = await vault.diff(rest[0], rest[1]);
      out(d, formatDiff(d, Infinity));
      return 0;
    }
    case "pending": {
      const moves = await vault.pendingMoves(values.batch);
      out(moves, moves.map((m) => `${m.at}  ${m.from} -> ${m.to}${m.batch ? `  [${m.batch}]` : ""}`).join("\n") || "nothing to undo");
      return 0;
    }
    case "undo": {
      const r = await vault.undo({ batch: values.batch, count: num(values.count) });
      out(r, [`undone ${r.undone.length}`, ...r.skipped.map((s) => `skipped ${s.to}: ${s.reason}`)].join("\n"));
      return r.skipped.length ? 2 : 0;
    }
    case "restore": {
      if (!rest[0]) throw new Error("restore needs a snapshot id");
      const r = await vault.restore(rest[0], { paths: rest.length > 1 ? rest.slice(1) : undefined });
      out(r, `restored ${r.restored}, unchanged ${r.skipped}${r.guard ? `\nprevious content saved as ${r.guard}` : ""}`);
      return 0;
    }
    case "gc": {
      const r = await vault.gc({ keepLast: num(values["keep-last"]), olderThanDays: num(values["older-than-days"]), dryRun: !values.apply });
      out(r, `${r.dryRun ? "would drop" : "dropped"} ${r.snapshots.length} snapshots, ${r.blobs} blobs (${(r.bytes / 1024 ** 2).toFixed(1)} MB)`);
      return 0;
    }
    case "plans": {
      const list = await vault.plans();
      out(list, list.map((p) => `${p.id}  ${p.created}  ${String(p.ops.length).padStart(5)} ops  ${planState(p)}${p.by?.reason ? `  — ${p.by.reason}` : ""}`).join("\n") || "no plans");
      return 0;
    }
    case "show": {
      const p = await vault.getPlan(need(rest[0], "show needs a plan id"));
      const ops = p.ops.map((o, i) => `${String(i).padStart(4)}  ${o.op === "move" ? `move  ${o.from} -> ${o.to}` : `trash ${o.path}`}`);
      const issues = p.issues.map((i) => `  #${i.index} ${i.code}: ${i.message}`);
      out(p, [`plan ${p.id}  ${planState(p)}${p.by ? `  by ${describe(p.by)}` : ""}`, ...ops, ...(issues.length ? ["issues:", ...issues] : [])].join("\n"));
      return 0;
    }
    case "approve": {
      const p = await vault.approve(need(rest[0], "approve needs a plan id"), values.by ?? process.env.USER ?? process.env.USERNAME);
      out(p, `approved ${p.id} (${p.ops.length} operations)${p.issues.length ? ` — it has ${p.issues.length} issues and will not apply` : ""}`);
      return 0;
    }
    case "apply": {
      const r = await vault.apply(need(rest[0], "apply needs a plan id"), { batch: values.batch });
      out(r, `applied ${r.done} operations as batch ${r.batch}${r.failed ? `\nstopped at #${r.failed.index} ${r.failed.code}: ${r.failed.message}\nundo with: wasnew undo --batch ${r.batch}` : ""}`);
      return r.failed ? 2 : 0;
    }
    case "history": {
      const events = await vault.history(need(rest[0], "history needs a path"));
      out(events, events.map((e) => `${e.at}  ${e.op.padEnd(7)} ${e.from ? `${e.from} -> ${e.to}` : e.to ?? ""}${e.undone ? " (undone)" : ""}${e.by ? `  by ${describe(e.by)}` : ""}`).join("\n") || "nothing recorded");
      return 0;
    }
    case "recover": {
      const items = await vault.recover();
      out(items, items.map((i) => `${i.outcome.padEnd(12)} ${i.op} ${i.from} -> ${i.to}`).join("\n") || "nothing to recover");
      return items.some((i) => i.outcome === "both-exist" || i.outcome === "missing") ? 2 : 0;
    }
    case "empty-trash": {
      const days = num(values["older-than-days"]);
      if (days === undefined) throw new Error("empty-trash needs --older-than-days");
      const r = await vault.emptyTrash({ olderThanDays: days, dryRun: !values.apply });
      out(r, `${r.dryRun ? "would delete" : "deleted"} ${r.entries.length} trashed items (${(r.bytes / 1024 ** 2).toFixed(1)} MB)${r.dryRun && r.entries.length ? "\nrun again with --apply to delete" : ""}`);
      return 0;
    }
    case "policy": {
      const p = (await vault.policy()).policy;
      out(p, Object.keys(p).some((k) => (p as any)[k] !== undefined) ? JSON.stringify(p, null, 2) : "no policy (.wasnew/policy.json)");
      return 0;
    }
    default:
      console.error(`unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}

function need(v: string | undefined, message: string): string {
  if (!v) throw new Error(message);
  return v;
}

function planState(p: Plan): string {
  if (p.applied) return `applied as ${p.applied.batch}`;
  if (p.issues.length) return `${p.issues.length} issues`;
  if (p.approved) return "approved";
  return p.needsApproval ? "needs approval" : "ready";
}

function describe(by: Actor): string {
  return [by.agent, by.model].filter(Boolean).join(" / ") + (by.reason ? ` — ${by.reason}` : "");
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  console.error(isWasnewError(e) ? `${e.code}: ${e.message}` : String(e?.message ?? e));
  process.exitCode = 1;
});
