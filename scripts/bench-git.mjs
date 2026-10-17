// Times wasnew against git on the same jobs: first snapshot, unchanged re-snapshot, reorganize every
// file into sorted/<ext>/, undo that, trash 10% and undo, then store size. git runs twice: default
// config, and with compression off (fair, since the data is incompressible like photos and video).
// Each tool works on its own fresh copy. Run `pnpm build` first.
//   node scripts/bench-git.mjs [--shape small|media|all] [--runs N] [--dir path]
import { openVault } from "../dist/index.js";
import { promises as fs } from "node:fs";
import { randomFillSync } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import path from "node:path";
import os from "node:os";

const run = promisify(execFile);
const { values: args } = parseArgs({ options: { shape: { type: "string", default: "all" }, runs: { type: "string", default: "3" }, dir: { type: "string" } } });
const RUNS = Math.max(1, Number(args.runs) || 3);
const SHAPES = {
  small: { files: 5000, size: 4 * 1024, folders: 50, exts: ["jpg", "png", "txt", "pdf", "mp4"] },
  media: { files: 8, size: 256 * 1024 ** 2, folders: 2, exts: ["mp4", "mov"] },
};
const shapes = args.shape === "all" ? ["small", "media"] : [args.shape];
for (const s of shapes) if (!SHAPES[s]) throw new Error(`unknown shape ${s}; use small, media or all`);

const IDENTITY = ["-c", "user.name=bench", "-c", "user.email=bench@example.invalid"];
const TOOLS = {
  wasnew: null,
  git: [...IDENTITY],
  "git (no compression)": [...IDENTITY, "-c", "core.compression=0", "-c", "core.looseCompression=0"],
};
const STEPS = ["first snapshot", "re-snapshot, nothing changed", "reorganize", "undo reorganize", "trash 10% + undo", "store size (MB)"];

const git = (cwd, cfg, ...a) => run("git", [...cfg, ...a], { cwd, maxBuffer: 64 * 1024 ** 2 });
const now = () => performance.now();
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Files under dir, posix-relative, sorted; the tools' own stores are left out */
async function listFiles(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const rel = path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).replaceAll("\\", "/");
    if (rel.startsWith(".git/") || rel.startsWith(".wasnew/")) continue;
    out.push(rel);
  }
  return out.sort();
}

async function sizeOf(p) {
  const st = await fs.stat(p).catch(() => null);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of await fs.readdir(p)) total += await sizeOf(path.join(p, e));
  return total;
}

function same(a, b, what) {
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
    throw new Error(`${what}: file set not restored (${b.length} files, expected ${a.length})`);
  }
}

async function generate(dir, shape) {
  const buf = Buffer.alloc(Math.min(shape.size, 16 * 1024 ** 2));
  for (let i = 0; i < shape.files; i++) {
    const folder = path.join(dir, `folder-${i % shape.folders}`);
    await fs.mkdir(folder, { recursive: true });
    const fh = await fs.open(path.join(folder, `file-${i}.${shape.exts[i % shape.exts.length]}`), "w");
    for (let left = shape.size; left > 0; left -= buf.length) {
      randomFillSync(buf);
      await fh.write(buf, 0, Math.min(buf.length, left));
    }
    await fh.close();
  }
}

async function oneRun(tool, work, files) {
  const cfg = TOOLS[tool];
  const t = {};
  const reorg = files.map((f) => ({ from: f, to: `sorted/${path.extname(f).slice(1) || "other"}/${path.basename(f)}` }));
  const victims = files.filter((_, i) => i % 10 === 0);
  let a;
  if (!cfg) {
    const v = await openVault(work);
    a = now(); await v.snapshot(); t[STEPS[0]] = now() - a;
    a = now(); const s = await v.snapshot({ skipIfUnchanged: true }); t[STEPS[1]] = now() - a;
    if (!s.unchanged) throw new Error("wasnew re-snapshot was not seen as unchanged");
    a = now(); const m = await v.moveMany(reorg, "reorg"); t[STEPS[2]] = now() - a;
    if (m.failed) throw new Error(`wasnew moveMany failed: ${JSON.stringify(m.failed)}`);
    a = now(); await v.undo({ batch: "reorg" }); t[STEPS[3]] = now() - a;
    same(files, await listFiles(work), "wasnew undo");
    a = now(); const tr = await v.trashMany(victims, "trash"); await v.undo({ batch: "trash" }); t[STEPS[4]] = now() - a;
    if (tr.failed) throw new Error(`wasnew trashMany failed: ${JSON.stringify(tr.failed)}`);
    same(files, await listFiles(work), "wasnew trash undo");
    t[STEPS[5]] = (await sizeOf(path.join(work, ".wasnew"))) / 1024 ** 2;
  } else {
    a = now();
    await git(work, cfg, "init", "-q");
    await git(work, cfg, "add", "-A");
    await git(work, cfg, "commit", "-q", "-m", "first");
    t[STEPS[0]] = now() - a;
    a = now();
    const { stdout } = await git(work, cfg, "status", "--porcelain");
    await git(work, cfg, "add", "-A");
    if (stdout.trim()) await git(work, cfg, "commit", "-q", "-m", "again");
    t[STEPS[1]] = now() - a;
    a = now();
    const made = new Set();
    for (const m of reorg) {
      const dir = path.dirname(path.join(work, m.to));
      if (!made.has(dir)) { await fs.mkdir(dir, { recursive: true }); made.add(dir); }
      await fs.rename(path.join(work, m.from), path.join(work, m.to));
    }
    await git(work, cfg, "add", "-A");
    await git(work, cfg, "commit", "-q", "-m", "reorg");
    t[STEPS[2]] = now() - a;
    a = now(); await git(work, cfg, "reset", "-q", "--hard", "HEAD~1"); t[STEPS[3]] = now() - a;
    same(files, await listFiles(work), `${tool} reset`);
    a = now();
    const child = execFile("git", [...cfg, "rm", "-q", "--pathspec-from-file=-"], { cwd: work });
    const done = new Promise((resolve, reject) => child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`git rm exited ${code}`)))));
    child.stdin.end(victims.join("\n") + "\n");
    await done;
    await git(work, cfg, "reset", "-q", "--hard");
    t[STEPS[4]] = now() - a;
    same(files, await listFiles(work), `${tool} trash reset`);
    t[STEPS[5]] = (await sizeOf(path.join(work, ".git"))) / 1024 ** 2;
  }
  return t;
}

const base = args.dir ? path.resolve(args.dir) : os.tmpdir();
await fs.mkdir(base, { recursive: true });
const tmp = await fs.mkdtemp(path.join(base, "wasnew-bench-git-"));
const { stdout: gitVersion } = await run("git", ["--version"]);
try {
  for (const name of shapes) {
    const shape = SHAPES[name];
    const bytes = shape.files * shape.size;
    const st = await fs.statfs(tmp);
    const free = st.bavail * st.bsize;
    if (free < 5 * bytes) {
      throw new Error(`not enough free space for shape ${name}: needs ${(5 * bytes / 1024 ** 3).toFixed(1)} GiB, ${(free / 1024 ** 3).toFixed(1)} GiB free under ${tmp} (use --dir)`);
    }
    const source = path.join(tmp, "source");
    await generate(source, shape);
    const files = await listFiles(source);
    const results = Object.fromEntries(Object.keys(TOOLS).map((k) => [k, Object.fromEntries(STEPS.map((s) => [s, []]))]));
    for (let r = 0; r < RUNS; r++) {
      for (const tool of Object.keys(TOOLS)) {
        const work = path.join(tmp, "work");
        await fs.cp(source, work, { recursive: true });
        try {
          const t = await oneRun(tool, work, files);
          for (const s of STEPS) results[tool][s].push(t[s]);
        } finally {
          await fs.rm(work, { recursive: true, force: true });
        }
      }
    }
    await fs.rm(source, { recursive: true, force: true });
    const human = shape.size >= 1024 ** 2 ? `${shape.size / 1024 ** 2} MB` : `${shape.size / 1024} KB`;
    console.log(`\n### ${name}: ${shape.files.toLocaleString("en")} files × ${human}, median of ${RUNS} run(s), ms unless noted\n`);
    console.log(`| step | ${Object.keys(TOOLS).join(" | ")} |`);
    console.log(`|---|${Object.keys(TOOLS).map(() => "---:").join("|")}|`);
    const fmt = (s, x) => (s.includes("MB") ? x.toFixed(1) : Math.round(x).toLocaleString("en"));
    for (const s of STEPS) {
      const cells = Object.keys(TOOLS).map((k) => fmt(s, median(results[k][s])));
      console.log(`| ${s} | ${cells.join(" | ")} |`);
    }
    // the raw values too, so the spread between runs is visible
    console.log(`\nEach run in order, min and max in brackets:\n`);
    console.log(`| step | ${Object.keys(TOOLS).join(" | ")} |`);
    console.log(`|---|${Object.keys(TOOLS).map(() => "---:").join("|")}|`);
    for (const s of STEPS) {
      const cells = Object.keys(TOOLS).map((k) => {
        const xs = results[k][s];
        return `${xs.map((x) => fmt(s, x)).join(" / ")} [${fmt(s, Math.min(...xs))}, ${fmt(s, Math.max(...xs))}]`;
      });
      console.log(`| ${s} | ${cells.join(" | ")} |`);
    }
  }
  console.log("\n" + JSON.stringify({ platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, node: process.version, git: gitVersion.trim(), shapes, runs: RUNS }));
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
