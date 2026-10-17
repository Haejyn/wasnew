#!/usr/bin/env node
// Copies a recorded take into scripts/demo/take/ with machine details taken out: absolute paths
// become ~/Downloads and ~/wasnew, the user name becomes "me", session ids and uuids become
// placeholders. The agent's words and the tool results are otherwise left as they were.
// usage: node scripts/demo/scrub.mjs <raw take dir> [out dir]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const [raw, outArg] = process.argv.slice(2);
if (!raw) {
  console.error("usage: node scripts/demo/scrub.mjs <raw take dir> [out dir]");
  process.exit(1);
}
const out = path.resolve(outArg ?? path.join(here, "take"));
mkdirSync(out, { recursive: true });

const jsonl = readdirSync(raw).filter((f) => f.endsWith(".jsonl")).sort();
const first = JSON.parse(readFileSync(path.join(raw, jsonl[0]), "utf8").split("\n")[0]);
const demo = first.cwd;   // the folder the session ran in
const user = os.userInfo().username;
const home = os.homedir();

// every spelling of a path: C:\a\b, C:/a/b, and the dashed form Claude Code uses for project folders
const spellings = (p) => [p, p.replaceAll("\\", "/"), p.replace(/[:\\/.]/g, "-")];
const swaps = [
  ...spellings(demo).map((s, i) => [s, i === 2 ? "-Downloads" : "~/Downloads"]),
  ...spellings(repo).map((s, i) => [s, i === 2 ? "-wasnew" : "~/wasnew"]),
  ...spellings(home).map((s, i) => [s, i === 2 ? "-home" : "~"]),
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function clean(s) {
  for (const [from, to] of swaps) s = s.replace(new RegExp(esc(from), "gi"), to);
  // ~/Downloads\Documents\x.pdf -> ~/Downloads/Documents/x.pdf
  s = s.replace(/~(\/[\w.-]+)?((?:\\[^\\\s"'<>|]+)+\\?)/g, (_, a = "", b) => `~${a}${b.replaceAll("\\", "/")}`);
  // the user name as file owner in ls -l output, and anywhere else
  s = s.replace(new RegExp(`\\b${esc(user)}\\b`, "gi"), "me");
  return s;
}

const ids = new Map();
const placeholder = (kind, v) => {
  if (!ids.has(v)) ids.set(v, `${kind}-${[...ids.keys()].filter((k) => ids.get(k).startsWith(kind)).length + 1}`);
  return ids.get(v);
};
function walk(v, key) {
  if (typeof v === "string") {
    if (key === "session_id") return placeholder("session", v);
    if (key === "uuid" || key === "parent_uuid") return placeholder("uuid", v);
    return clean(v);
  }
  if (Array.isArray(v)) return v.map((x) => walk(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
  return v;
}

for (const f of jsonl) {
  const lines = readFileSync(path.join(raw, f), "utf8").split("\n").filter((l) => l.trim());
  writeFileSync(path.join(out, f), lines.map((l) => {
    const e = walk(JSON.parse(l));
    // the init event lists this machine's plugins, skills and slash commands; keep only what the replay needs
    if (e.type === "system" && e.subtype === "init") {
      for (const k of ["slash_commands", "terminal_slash_commands", "skills", "plugins", "agents", "memory_paths", "capabilities", "messaging_socket_path"]) delete e[k];
    }
    return JSON.stringify(e);
  }).join("\n") + "\n");
}
if (existsSync(path.join(raw, "cli.json"))) {
  writeFileSync(path.join(out, "cli.json"), JSON.stringify(walk(JSON.parse(readFileSync(path.join(raw, "cli.json"), "utf8"))), null, 2) + "\n");
}
if (existsSync(path.join(raw, "prompts.json"))) writeFileSync(path.join(out, "prompts.json"), readFileSync(path.join(raw, "prompts.json"), "utf8"));
console.log(`scrubbed ${jsonl.length} logs into ${out}`);
