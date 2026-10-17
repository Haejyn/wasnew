#!/usr/bin/env node
// Replays the recorded take (scripts/demo/take/) as a terminal and renders it to
// assets/demo.mp4, assets/demo.gif and assets/demo-poster.png.
// usage: node scripts/demo/render.mjs [take dir]
// Needs ffmpeg on PATH and playwright with chromium. Playwright is not a dependency of wasnew:
// install it anywhere (npm i playwright && npx playwright install chromium) and point
// PLAYWRIGHT_DIR at that folder if it is not resolvable from here.
//
// What the replay changes: it shows tool calls as one line each with a short result, keeps only
// the prose paragraphs of the agent's answers (tables and lists are cut, with a line saying so),
// leaves out ToolSearch calls (Claude Code loading tool schemas) and squeezes the waits between
// events to a fixed pace. Words and results it does show are the recorded ones.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const take = path.resolve(process.argv[2] ?? path.join(here, "take"));
const assets = path.join(repo, "assets");
const W = 1280, H = 720, FPS = 25;

const read = (f) => readFileSync(path.join(take, f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const sessions = ["1.jsonl", "2.jsonl", "3.jsonl"].map(read);
const cli = JSON.parse(readFileSync(path.join(take, "cli.json"), "utf8"));
const prompts = JSON.parse(readFileSync(path.join(take, "prompts.json"), "utf8"));

// ---- timeline -------------------------------------------------------------------------------
const items = [];
let t = 600;
const TYPE = 18;                                   // ms per typed character
// wrapped rows line up under the text after the leading marker ("● ", "↳ ", "✗ ")
const line = (segs, o = {}) => {
  const lead = (segs[0]?.[1] ?? "").match(/^ */)[0].length;
  const marker = /^ *[●↳✗] /.test(segs[0]?.[1] ?? "") ? 2 : 0;
  items.push({ at: t, segs, hang: lead + marker || undefined, ...o });
};
const gap = (ms) => { t += ms; };
const PS = "~/Downloads $ ";
function shell(cmd, after) {
  // the prompt is shown whole, the command typed
  line([["p", PS], ["a", cmd]], { type: TYPE, pre: PS.length });
  t += cmd.length * TYPE;
  gap(after ?? 400);
}

const short = (s, n = 96) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const textOf = (c) => (typeof c === "string" ? c : (c ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n"));
const dur = (ms) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; };

function callLine(name, input) {
  const n = name.replace(/^mcp__wasnew__/, "");
  let arg;
  switch (n) {
    case "Bash": arg = input.command.replace(/^cd "[^"]*" && /, "").split("\n")[0]; break;
    case "Read": arg = input.file_path; break;
    case "wasnew_snapshot": arg = `"${input.label}"`; break;
    case "wasnew_plan": arg = `${input.ops.length} ops`; break;
    case "wasnew_apply": arg = `plan ${input.plan}`; break;
    case "wasnew_trash": arg = input.paths.join(", "); break;
    default: arg = JSON.stringify(input);
  }
  return [["d", "  ● "], ["t", n], ["a", "  " + short(arg, 90)]];
}

function resultLines(name, input, res) {
  const n = name.replace(/^mcp__wasnew__/, "");
  const text = textOf(res.content);
  if (res.is_error) {
    const m = text.match(/^PreToolUse:\w+ hook error: \[node "[^"]*?([\w.-]+\.mjs)"\]: ([\s\S]*)$/);
    if (m) return [[["b", `    ✗ hook ${m[1]}: `], ["b", m[2].trim()]]];
    return [[["b", "    ✗ " + short(text.trim())]]];
  }
  const out = (s) => [["d", "    ↳ "], ["a", s]];
  let j;
  try { j = JSON.parse(text); } catch { j = null; }
  switch (n) {
    case "wasnew_snapshot": return [out(`snapshot ${j.id}, ${j.fileCount} files`)];
    case "wasnew_plan": return [
      ...j.summary.map((s) => [["d", "    "], ["a", s]]),
      out(`plan ${j.id}: ${j.ops} ops, ${j.issues.length} issues, ${j.needsApproval ? "needs approval" : "no approval needed"}`),
    ];
    case "wasnew_apply": return [out(`batch ${j.batch}, ${j.done} done`)];
    case "wasnew_trash": return [out(`${j.summary.join("; ")}, batch ${j.batch}`)];
    case "Read": return [out(text.split("\n")[0])];
    default: {
      const ls = text.trimEnd().split("\n");
      return [[["d", "    ↳ "], ["a", short(ls[0], 88)], ["d", ls.length > 1 ? `  (${ls.length} lines)` : ""]]];
    }
  }
}

function agentText(text) {
  // prose paragraphs only; tables, lists and "Heading:" lines are cut and counted
  const paras = text.trim().split(/\n\s*\n/);
  const out = [];
  let cut = 0;
  for (const p of paras) {
    const prose = !/^(\||- |\*\*|\d+\. )/.test(p) && !/:\s*$/.test(p.split("\n")[0]);
    if (prose && out.length < 2) out.push(p.replace(/\*\*/g, ""));
    else cut += p.split("\n").length;
  }
  out.forEach((p, i) => { line([["g", "  " + p.replace(/\n/g, " ")]]); if (i < out.length - 1) gap(700); });
  if (cut) line([["d", `  (${cut} more lines of the answer not shown)`]]);
}

const commands = [
  (p) => `claude -p "${p}"`,
  (p) => `claude -p "${p}"`,
  (p) => `claude -p -c "${p}"`,      // recorded with --resume <session of prompt 2>
];
let poster = 0;
sessions.forEach((ev, si) => {
  const prompt = prompts[si].text;
  if (si > 0) { line([["d", ""]]); gap(150); }
  shell(commands[si](prompt), 500);
  const uses = new Map();
  for (const e of ev) {
    if (e.type === "assistant") {
      for (const c of e.message.content) {
        if (c.type === "tool_use") {
          uses.set(c.id, c);
          if (c.name === "ToolSearch") continue;
          line(callLine(c.name, c.input));
          gap(c.name.includes("wasnew_plan") ? 600 : 380);
        } else if (c.type === "text" && c.text.trim() && e !== ev.findLast((x) => x.type === "assistant")) {
          line([["g", "  " + c.text.trim()]]);
          gap(600);
        }
      }
    } else if (e.type === "user" && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type !== "tool_result") continue;
        const u = uses.get(c.tool_use_id);
        if (!u || u.name === "ToolSearch") continue;
        const ls = resultLines(u.name, u.input, c);
        for (const l of ls) { line(l); gap(ls.length > 3 ? 60 : 0); }
        gap(c.is_error ? 1700 : 420);
      }
    } else if (e.type === "result") {
      agentText(e.result);
      gap(200);
      line([["d", `  (finished in ${dur(e.duration_ms)})`]]);
      gap(si === 0 ? 1300 : 2000);
      if (si === 2) poster = t - 200;
    }
  }
});

// the CLI part
line([["d", ""]]);
for (const c of cli) {
  shell(c.cmd, 350);
  const ls = c.out.split("\n");
  const keep = c.cmd === "wasnew pending" ? 3 : ls.length;
  for (const l of ls.slice(0, keep)) line([["a", short(l, 118)]]);
  if (ls.length > keep) line([["d", `… ${ls.length - keep} more`]]);
  gap(c.cmd.startsWith("ls") ? 700 : 1000);
}
line([["p", PS]], { cursor: true });
gap(2600);
const END = t;
console.log(`timeline ${(END / 1000).toFixed(1)} s, ${items.length} lines`);

// ---- frames -----------------------------------------------------------------------------------
const req = createRequire(process.env.PLAYWRIGHT_DIR ? path.join(path.resolve(process.env.PLAYWRIGHT_DIR), "x.js") : import.meta.url);
const { chromium } = req("playwright");
const tmp = path.join(os.tmpdir(), "wasnew-demo-frames");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.join(here, "player.html")).href);
await page.evaluate((list) => window.load(list), items);
await page.evaluate(() => document.fonts.ready);

// one screenshot per distinct frame; the concat list holds how long each one stays
const frames = [];
let prev = null;
for (let f = 0; f * 1000 / FPS < END; f++) {
  const html = await page.evaluate((ms) => window.seek(ms), f * 1000 / FPS);
  if (html === prev) { frames.at(-1).n++; continue; }
  prev = html;
  const file = path.join(tmp, `${String(frames.length).padStart(5, "0")}.png`);
  await page.screenshot({ path: file });
  frames.push({ file, n: 1 });
}
await page.evaluate((ms) => window.seek(ms), poster);
await page.screenshot({ path: path.join(assets, "demo-poster.png") });
await browser.close();
console.log(`${frames.length} distinct frames`);

const list = frames.map((f) => `file '${f.file.replaceAll("\\", "/")}'\nduration ${(f.n / FPS).toFixed(3)}`).join("\n") + `\nfile '${frames.at(-1).file.replaceAll("\\", "/")}'\n`;
writeFileSync(path.join(tmp, "list.txt"), list);

const len = ["-t", (END / 1000).toFixed(2)];   // the concat list repeats the last frame; cut it to the timeline
const ff = (...a) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a], { stdio: "inherit" });
const mp4 = path.join(assets, "demo.mp4");
const gif = path.join(assets, "demo.gif");
ff("-f", "concat", "-safe", "0", "-i", path.join(tmp, "list.txt"), "-vf", `fps=${FPS},format=yuv420p`,
  "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-tune", "stillimage", "-movflags", "+faststart", ...len, mp4);
const pal = path.join(tmp, "palette.png");
// the GIF is made from the PNG frames, not from the MP4: compression noise would make every frame differ
const src = ["-f", "concat", "-safe", "0", "-i", path.join(tmp, "list.txt")];
ff(...src, "-vf", "fps=10,palettegen=max_colors=64:stats_mode=full", pal);
ff(...src, "-i", pal, "-lavfi", "fps=10[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle", ...len, gif);
rmSync(tmp, { recursive: true, force: true });
for (const f of [mp4, gif]) console.log(`${path.relative(repo, f)}  ${(statSync(f).size / 1024 ** 2).toFixed(2)} MB`);
