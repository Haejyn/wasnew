#!/usr/bin/env node
// Claude Code PreToolUse hook for Read, Edit and Write: when the file is gone and wasnew's journal
// says it moved, blocks the call and tells the agent the new path. It never blocks when the file
// exists or the journal knows nothing about it. One journal read, no dependencies; any error lets
// the call through. Mirrors Vault.where() in src/index.ts.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const pass = () => process.exit(0);
let input = "";
for await (const chunk of process.stdin) input += chunk;
try {
  run(JSON.parse(input));
} catch {
  pass();
}
pass();

function run(hook) {
  const file = hook?.tool_input?.file_path ?? hook?.tool_input?.notebook_path;
  if (typeof file !== "string" || !file) return;
  const abs = path.resolve(typeof hook.cwd === "string" ? hook.cwd : process.cwd(), file);
  if (existsSync(abs)) return;
  // the folder wasnew keeps: the nearest parent with a journal
  let root;
  for (let d = path.dirname(abs); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".wasnew", "journal.jsonl"))) { root = d; break; }
    if (path.dirname(d) === d) break;
  }
  if (!root) return;
  const inside = (p) => (p === root || p.startsWith(root + path.sep) ? path.relative(root, p).replaceAll("\\", "/") : null);
  const key = (p) => { const a = path.resolve(root, p); return inside(a) ?? a.replaceAll("\\", "/"); };
  const start = inside(abs);
  if (start === null) return;
  let text;
  try { text = readFileSync(path.join(root, ".wasnew", "journal.jsonl"), "utf8"); } catch { return; }

  const fold = process.platform === "win32" || process.platform === "darwin";
  const under = (p, dir) => {
    const a = fold ? p.toLowerCase() : p, b = fold ? dir.toLowerCase() : dir;
    if (a === b) return "";
    return a.startsWith(b + "/") ? p.slice(dir.length) : null;
  };
  const seen = new Map();
  const live = [];   // moves and trashes of this path not undone since
  let cur = start, trashed;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (e.op === "move" || e.op === "trash") {
      const m = { op: e.op, from: key(e.from), to: e.op === "trash" ? e.to : key(e.to) };
      seen.set(e.seq, m);
      if (trashed) continue;
      const rest = under(cur, m.from);
      if (rest === null) continue;
      if (e.op === "move") cur = m.to + rest;
      else trashed = { seq: e.seq, path: m.to + rest };
      live.push(e);
    } else if (e.op === "undo") {
      const m = seen.get(e.of);
      if (!m) continue;
      const i = live.findIndex((x) => x.seq === e.of);
      if (i >= 0) live.splice(i, 1);
      if (m.op === "trash") {
        if (trashed?.seq !== e.of) continue;
        cur = m.from + (under(trashed.path, m.to) ?? "");
        trashed = undefined;
      } else if (!trashed) {
        const rest = under(cur, m.to);
        if (rest !== null) cur = m.from + rest;
      }
    } else if (e.op === "purge" && trashed && e.of?.includes(trashed.seq)) {
      return;   // gone for good, nothing to point at
    }
  }
  const last = live.at(-1);
  if (!last) return;
  const by = last.by?.agent ?? last.by?.model;
  const when = `${by ? ` by ${by}` : ""} at ${String(last.at).slice(0, 16)}Z${last.batch ? `, batch ${last.batch}` : ""}`;
  if (trashed) {
    // writing a new file where a trashed one was is a normal thing to do
    if (hook.tool_name === "Write" || !existsSync(path.join(root, ".wasnew", trashed.path))) return;
    block(`${start} is in wasnew's trash (trashed${when}). Undo that batch with wasnew_undo to bring it back, or ask the user.`);
  }
  const now = path.join(root, cur);
  if (cur === start || !existsSync(now)) return;
  block(`${start} was moved to ${cur} (${when.trim()}). Use ${now} instead.`);
}

function block(reason) {
  console.error(`Blocked: ${reason}`);
  process.exit(2);
}
