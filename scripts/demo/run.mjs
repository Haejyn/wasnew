#!/usr/bin/env node
// Records one take of the demo: real Claude Code, headless, in the folder setup.mjs made.
// usage: node scripts/demo/run.mjs <demo dir> <out dir>
// Writes <out>/1.jsonl, 2.jsonl, 3.jsonl (claude --output-format stream-json --verbose) and
// <out>/cli.json (the wasnew CLI commands run afterwards and what they printed), and a copy of
// prompts.json.
// Nothing here edits what the agent or the tools said; render.mjs only replays it.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [dir, out] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!dir || !out) {
  console.error("usage: node scripts/demo/run.mjs <demo dir> <out dir>");
  process.exit(1);
}
mkdirSync(out, { recursive: true });

// prompts.json: prompt 2 starts a new session ("fresh"), like coming back later. The agent there
// does not know where the sort put things, so it asks for the old path and the moved.mjs hook
// points it at the new one. Prompt 3 continues that second session.
const prompts = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts.json"), "utf8"));
writeFileSync(path.join(out, "prompts.json"), JSON.stringify(prompts, null, 2) + "
");

const base = [
  "-p",
  "--output-format", "stream-json", "--verbose",
  "--mcp-config", path.join(dir, ".mcp.json"), "--strict-mcp-config",
  // only this folder's .claude/settings.json (the hooks), not the recording machine's own settings
  "--setting-sources", "project",
  "--permission-mode", "dontAsk",
  "--allowedTools", "mcp__wasnew", "Read", "Bash", "Glob", "Grep",
  // on Windows Claude Code also offers a PowerShell tool; the example guard hook is set up for Bash
  "--disallowedTools", "PowerShell",
];

function claude(args, file) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn("claude", args, { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });
    let buf = "";
    const lines = [];
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        // keep the wall clock so the replay can follow the real pacing
        try { lines.push(JSON.stringify({ t: Date.now() - t0, ...JSON.parse(line) })); } catch { lines.push(line); }
        process.stdout.write(".");
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      writeFileSync(file, lines.join("\n") + "\n");
      process.stdout.write(` exit ${code}\n`);
      resolve(lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } }));
    });
  });
}

let session;
for (const [i, prompt] of prompts.entries()) {
  console.log(`prompt ${i + 1}: ${prompt.text}`);
  if (prompt.fresh) session = undefined;
  const args = [...base, ...(session ? ["--resume", session] : []), "--", prompt.text];
  const events = await claude(args, path.join(out, `${i + 1}.jsonl`));
  session = events.find((e) => e.type === "system" && e.session_id)?.session_id ?? session;
}

// the CLI part: what is pending, then undo every batch newest first
const wasnew = (...a) => {
  const r = spawnSync(process.execPath, [path.join(repo, "bin", "wasnew.js"), ...a, "--root", dir], { encoding: "utf8" });
  return { cmd: `wasnew ${a.join(" ")}`, out: (r.stdout + r.stderr).trimEnd(), code: r.status };
};
const top = () => readdirSync(dir).filter((n) => !n.startsWith(".")).length;
const cli = [];
cli.push({ cmd: "ls | wc -l", out: String(top()), code: 0 });
cli.push(wasnew("pending"));
const pending = JSON.parse(spawnSync(process.execPath, [path.join(repo, "bin", "wasnew.js"), "pending", "--json", "--root", dir], { encoding: "utf8" }).stdout);
const moves = Array.isArray(pending) ? pending : pending.moves ?? [];
const batches = [...new Set(moves.map((m) => m.batch).filter(Boolean))];   // newest first
for (const b of batches) cli.push(wasnew("undo", "--batch", b));
cli.push({ cmd: "ls | wc -l", out: String(top()), code: 0 });
writeFileSync(path.join(out, "cli.json"), JSON.stringify(cli, null, 2) + "\n");
for (const c of cli) console.log(`$ ${c.cmd}\n${c.out}`);
