// Numbers other pages quote about wasnew (test counts, version, MCP tools), taken from a real test
// run so nobody copies them by hand. Exits non-zero if any test fails. mcpTools comes from the built
// server's tools/list, so run `pnpm build` first; without dist it is left out.
//   node scripts/facts.mjs [--out facts.json]
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";

const run = promisify(execFile);
const { values: args } = parseArgs({ options: { out: { type: "string" } } });
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(await fs.readFile(path.join(repo, "package.json"), "utf8"));
const commit = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
const committed = (await run("git", ["log", "-1", "--format=%cI", "HEAD"], { cwd: repo })).stdout.trim();
// en-CA formats as YYYY-MM-DD
const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(committed));

/** vitest's JSON report; the run's own exit code is ignored so the counts decide */
async function testReport() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wasnew-facts-"));
  const file = path.join(tmp, "vitest.json");
  try {
    const vitest = path.join(repo, "node_modules", "vitest", "vitest.mjs");
    await run(process.execPath, [vitest, "run", "--reporter=json", `--outputFile=${file}`], { cwd: repo, maxBuffer: 64 * 1024 ** 2 }).catch((e) => {
      if (e.code === undefined || typeof e.code === "string") throw e;   // could not start, not a failing test
    });
    return JSON.parse(await fs.readFile(file, "utf8"));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Tool count from the built MCP server's tools/list, on a throwaway root */
async function mcpTools() {
  const dist = path.join(repo, "dist", "mcp.js");
  if (!(await fs.stat(dist).catch(() => null))) return undefined;
  const { serveMcp } = await import(pathToFileURL(dist).href);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wasnew-facts-mcp-"));
  try {
    const input = new PassThrough(), output = new PassThrough();
    let raw = "";
    output.on("data", (c) => { raw += c; });
    const done = serveMcp({ root, input, output });
    input.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    await done;
    const reply = JSON.parse(raw.trim().split("\n")[0]);
    return reply.result.tools.length;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const report = await testReport();
const tests = {
  passed: report.numPassedTests,
  failed: report.numFailedTests,
  total: report.numTotalTests,
  files: report.testResults.length,
};
const tools = await mcpTools();
if (tools === undefined) console.error("dist/mcp.js not found, mcpTools left out (run pnpm build)");

const facts = { schema: 1, project: "wasnew", version: pkg.version, commit, date, tests, ...(tools === undefined ? {} : { mcpTools: tools }) };
const text = JSON.stringify(facts, null, 2) + "\n";
if (args.out) await fs.writeFile(path.resolve(args.out), text);
else process.stdout.write(text);

const broken = report.numFailedTestSuites ?? 0;
if (tests.failed > 0 || broken > 0 || report.success === false) {
  console.error(`${tests.failed} test(s) failed in ${broken} file(s)`);
  process.exit(1);
}
