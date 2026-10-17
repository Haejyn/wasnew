import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { agentName, openVault, parsePolicy, type Vault } from "./index.js";
import { serveMcp } from "./mcp.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "wasnew-lessons-"));
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});

const write = async (rel: string, text = rel) => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text);
};
const read = (rel: string) => fs.readFile(path.join(root, rel), "utf8");
const exists = (rel: string) => fs.access(path.join(root, rel)).then(() => true, () => false);
const setPolicy = async (p: object) => {
  await fs.mkdir(path.join(root, ".wasnew"), { recursive: true });
  await fs.writeFile(path.join(root, ".wasnew", "policy.json"), JSON.stringify(p));
};
const claude = (reason = "sort hwp") => ({ agent: "claude-code", reason });

/** Moves `n` files of one kind as one batch and undoes it */
async function undoneMoves(v: Vault, ext: string, n: number, to: string, batch: string, by = claude()) {
  for (let i = 0; i < n; i++) await write(`${batch}-${i}.${ext}`);
  await v.moveMany(Array.from({ length: n }, (_, i) => ({ from: `${batch}-${i}.${ext}`, to: `${to}/${batch}-${i}.${ext}` })), batch, by);
  await v.undo({ batch });
}

/** Runs moves with the clock set back, so they look `days` old */
async function daysAgo<T>(days: number, run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() - days * 86_400_000);
  try { return await run(); } finally { vi.useRealTimers(); }
}

async function session(messages: object[]) {
  const input = new PassThrough(), output = new PassThrough();
  let raw = "";
  output.on("data", (c) => { raw += c; });
  const done = serveMcp({ root, input, output });
  for (const m of messages) input.write(JSON.stringify(m) + "\n");
  input.end();
  await done;
  return raw.trim().split("\n").map((l) => JSON.parse(l));
}
const hello = (name = "claude-code") => ({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name } } });
const call = (id: number, name: string, args: object = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

describe("lessons", () => {
  it("turns repeated undos into an avoid line with the agent; reasons stay data, out of the line", async () => {
    const v = await openVault(root);
    await undoneMoves(v, "hwp", 2, "Docs", "b1");
    await undoneMoves(v, "HWP", 1, "Docs", "b2", claude("hwp files belong in Docs"));
    const { avoid, ok } = await v.lessons();
    expect(avoid.map((l) => l.line)).toEqual([`avoid: moving *.hwp from ./ to Docs/ was undone 3 of 3 times (claude-code)`]);
    expect(avoid[0].line).not.toContain("hwp files belong");   // past agents' words never reach another agent's instructions
    expect(avoid[0]).toMatchObject({ kind: "avoid", op: "move", ext: "hwp", fromDir: "./", toDir: "Docs/", total: 3, undone: 3, kept: 0, reasons: ["hwp files belong in Docs", "sort hwp"] });
    expect(ok).toEqual([]);
  });

  it("needs minUndone undos and at least half undone", async () => {
    const v = await openVault(root);
    await undoneMoves(v, "pdf", 1, "Papers", "p1");
    expect((await v.lessons()).avoid).toEqual([]);
    expect((await v.lessons({ minUndone: 1 })).avoid).toHaveLength(1);
    // 2 undone of 5 is under half
    await undoneMoves(v, "txt", 2, "Notes", "t1");
    for (let i = 0; i < 3; i++) await write(`k${i}.txt`);
    await v.moveMany([0, 1, 2].map((i) => ({ from: `k${i}.txt`, to: `Notes/k${i}.txt` })), "t2");
    expect((await v.lessons()).avoid).toEqual([]);
    await undoneMoves(v, "txt", 1, "Notes", "t3");
    expect((await v.lessons()).avoid.map((l) => [l.undone, l.total])).toEqual([[3, 6]]);
  });

  it("confirmed patterns: at least 5, never undone, older than a day", async () => {
    const v = await openVault(root);
    for (let i = 0; i < 6; i++) await write(`IMG_${i}.jpg`);
    await daysAgo(2, () => v.moveMany([0, 1, 2, 3, 4].map((i) => ({ from: `IMG_${i}.jpg`, to: `Pictures/2026/IMG_${i}.jpg` })), "old"));
    for (let i = 0; i < 5; i++) await write(`s${i}.png`);
    await v.moveMany([0, 1, 2, 3, 4].map((i) => ({ from: `s${i}.png`, to: `Shots/s${i}.png` })), "new");   // too fresh
    expect((await v.lessons()).ok.map((l) => l.line)).toEqual(["ok: *.jpg ./ → Pictures/2026/ kept 5 of 5"]);
    await v.move("IMG_5.jpg", "Pictures/2026/IMG_5.jpg", "x");
    await v.undo({ batch: "x" });
    expect((await v.lessons()).ok).toEqual([]);
  });

  it("names folders and trash, and a redo that stayed counts as kept", async () => {
    const v = await openVault(root);
    for (const b of ["f1", "f2"]) {
      await write(`old/${b}.txt`);
      await v.trash("old", b, claude("clean up"));
      await v.undo({ batch: b });
    }
    expect((await v.lessons()).avoid.map((l) => l.line)).toEqual([`avoid: trashing folders in ./ was undone 2 of 2 times (claude-code)`]);
    await v.redo({ batch: "f2" });
    expect((await v.lessons()).avoid).toEqual([]);
    expect((await v.lessons({ minUndone: 1 })).avoid[0]).toMatchObject({ undone: 1, total: 2, kept: 1 });
  });

  it("lessonsFor matches the ops of a list by pattern", async () => {
    const v = await openVault(root);
    await undoneMoves(v, "hwp", 2, "Docs", "b1");
    await write("new.hwp");
    await write("new.pdf");
    const found = await v.lessonsFor([{ op: "move", from: "new.hwp", to: "Docs/new.hwp" }, { op: "move", from: "new.pdf", to: "Docs/new.pdf" }, { op: "move", from: "new.hwp", to: "Other/new.hwp" }]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ matches: 1, ext: "hwp", toDir: "Docs/" });
  });

  it("MCP: initialize adds avoid lessons to the instructions, plan flags matching ops, wasnew_lessons lists them", async () => {
    const [plain] = await session([hello()]);
    expect(plain.result.instructions).not.toContain("Past undos");
    const v = await openVault(root);
    await undoneMoves(v, "hwp", 3, "Docs", "b1");
    await write("x.hwp");
    const [init, plan, lessons] = await session([
      hello(),
      call(1, "wasnew_plan", { ops: [{ op: "move", from: "x.hwp", to: "Docs/x.hwp" }] }),
      call(2, "wasnew_lessons"),
    ]);
    const line = `avoid: moving *.hwp from ./ to Docs/ was undone 3 of 3 times (claude-code)`;
    expect(init.result.instructions.startsWith(plain.result.instructions + "\n\nPast undos in this folder:\n- " + line)).toBe(true);
    expect(plan.result.structuredContent.lessons).toEqual([line + "; matches 1 of these operations"]);
    expect(plan.result.content[0].text).toContain("undone before in this folder:\n  " + line);
    expect(lessons.result.content[0].text).toBe(line);
    expect(lessons.result.structuredContent.avoid).toHaveLength(1);
  });
});

describe("agents and trust", () => {
  const trust = { requireApprovalOver: 2, trust: { minOps: 6, maxUndoRate: 0.2, approvalOver: 50 } };

  async function history(v: Vault) {
    for (let i = 0; i < 6; i++) await write(`g${i}.txt`);
    await v.moveMany([0, 1, 2, 3, 4, 5].map((i) => ({ from: `g${i}.txt`, to: `G/g${i}.txt` })), "good", { agent: "good-agent" });
    await undoneMoves(v, "txt", 6, "B", "bad", { agent: "bad-agent", reason: "x" });
    await write("u.txt");
    await v.move("u.txt", "U/u.txt", "anon");
  }

  it("keeps a record per agent", async () => {
    const v = await openVault(root);
    await history(v);
    const agents = await v.agents();
    expect(agents.map((a) => [a.agent, a.ops, a.undone, a.undoRate])).toEqual([["bad-agent", 6, 6, 1], ["good-agent", 6, 0, 0], ["unknown", 1, 0, 0]]);
    expect(agents[0].firstSeen <= agents[0].lastSeen).toBe(true);
  });

  it("a trusted agent gets the higher threshold; unknown and high-undo agents get the base", async () => {
    const v = await openVault(root);
    await history(v);
    await setPolicy(trust);
    expect(await v.approvalLimit("good-agent")).toBe(50);
    expect(await v.approvalLimit("bad-agent")).toBe(2);
    expect(await v.approvalLimit(undefined)).toBe(2);
    expect(await v.approvalLimit("unknown")).toBe(2);
    expect(await v.approvalLimit("new-agent")).toBe(2);
    await setPolicy({ requireApprovalOver: 10, trust: { minOps: 1, maxUndoRate: 1, approvalOver: 3 } });
    expect(await v.approvalLimit("good-agent")).toBe(10);   // never lower than the base

    await setPolicy(trust);
    for (let i = 0; i < 3; i++) await write(`n${i}.txt`);
    const ops = [0, 1, 2].map((i) => ({ op: "move" as const, from: `n${i}.txt`, to: `N/n${i}.txt` }));
    const good = await v.plan(ops, { by: { agent: "good-agent" } });
    expect(good.needsApproval).toBe(false);
    expect((await v.apply(good.id)).done).toBe(3);
    const bad = await v.plan(ops.map((o) => ({ ...o, from: o.to, to: o.from })), { by: { agent: "bad-agent" } });
    expect(bad.needsApproval).toBe(true);
    await expect(v.apply(bad.id)).rejects.toMatchObject({ code: "NEEDS_APPROVAL" });
  });

  it("MCP: the gate uses the client's threshold; wasnew_agents lists records", async () => {
    const v = await openVault(root);
    await history(v);
    await setPolicy(trust);
    for (let i = 0; i < 3; i++) await write(`m${i}.txt`);
    const moves = [0, 1, 2].map((i) => ({ from: `m${i}.txt`, to: `M/m${i}.txt` }));
    const [, bad] = await session([hello("bad-agent"), call(1, "wasnew_move", { moves })]);
    expect(bad.result.structuredContent.error.code).toBe("NEEDS_APPROVAL");
    const [, good, agents] = await session([hello("good-agent"), call(1, "wasnew_move", { moves }), call(2, "wasnew_agents")]);
    expect(good.result.structuredContent.moved).toBe(3);
    expect(agents.result.structuredContent.agents.find((a: any) => a.agent === "good-agent").ops).toBe(9);
  });

  it("validates the trust key", () => {
    expect(parsePolicy({ trust: { minOps: 50, maxUndoRate: 0.05, approvalOver: 200 } }).policy.trust).toEqual({ minOps: 50, maxUndoRate: 0.05, approvalOver: 200 });
    expect(() => parsePolicy({ trust: true })).toThrow(/policy.trust must be an object/);
    expect(() => parsePolicy({ trust: { minOps: 5, maxUndoRate: 0.1 } })).toThrow(/needs minOps and approvalOver/);
    expect(() => parsePolicy({ trust: { minOps: 5, maxUndoRate: 1.5, approvalOver: 9 } })).toThrow(/maxUndoRate must be a number from 0 to 1/);
    expect(() => parsePolicy({ trust: { minOps: -1, maxUndoRate: 0.1, approvalOver: 9 } })).toThrow(/trust.minOps/);
    expect(() => parsePolicy({ trust: { minOps: 5, maxUndoRate: 0.1, approvalOver: 9, extra: 1 } })).toThrow(/unknown policy.trust keys: extra/);
  });
});

const MOVED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "claude-code", "moved.mjs");
const hook = (file: string) => spawnSync(process.execPath, [MOVED], { input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: file } }), encoding: "utf8" });

describe("redo", () => {
  it("batch round trip: undo, redo, undo again; history and where stay right", async () => {
    await write("a.pdf", "A");
    await write("b.pdf", "B");
    const v = await openVault(root);
    await v.moveMany([{ from: "a.pdf", to: "Docs/a.pdf" }, { from: "b.pdf", to: "Docs/b.pdf" }], "t1", claude());
    await v.undo({ batch: "t1" });
    const r = await v.redo({ batch: "t1" });
    expect(r.skipped).toEqual([]);
    expect(r.redone.map((m) => [m.from, m.to, m.batch])).toEqual([["a.pdf", "Docs/a.pdf", "t1"], ["b.pdf", "Docs/b.pdf", "t1"]]);
    expect(await read("Docs/a.pdf")).toBe("A");
    expect(await v.pendingMoves("t1")).toHaveLength(2);
    const redos = (await v.readJournal()).filter((e) => e.op === "move" && (e as any).redoOf);
    expect(redos.map((e) => (e as any).redoOf)).toEqual([1, 2]);
    expect(await v.where("a.pdf")).toMatchObject({ status: "moved", current: "Docs/a.pdf", batch: "t1", by: claude() });
    expect((await v.history("a.pdf")).map((e) => [e.op, e.undone ?? false])).toEqual([["move", true], ["undo", false], ["move", false]]);
    expect(hook(path.join(root, "a.pdf")).stderr).toContain("a.pdf was moved to Docs/a.pdf");
    expect((await v.redo({ batch: "t1" })).redone).toEqual([]);   // nothing left to redo

    expect((await v.undo({ batch: "t1" })).undone).toHaveLength(2);
    expect(await read("a.pdf")).toBe("A");
    expect(await exists("Docs")).toBe(false);
    expect((await v.where("a.pdf")).status).toBe("here");
    await fs.rm(path.join(root, "a.pdf"));
    expect(hook(path.join(root, "a.pdf")).status).toBe(0);
    await write("a.pdf", "A");
    // the undone redo can itself be redone
    expect((await v.redo({ batch: "t1" })).redone).toHaveLength(2);
    expect(await read("Docs/b.pdf")).toBe("B");
  });

  it("-n takes the most recently undone first, so a chain replays in order", async () => {
    await write("a.txt", "A");
    const v = await openVault(root);
    await v.move("a.txt", "b.txt", "c");
    await v.move("b.txt", "c.txt", "c");
    await v.undo({ batch: "c" });
    await v.redo({ count: 1 });
    expect(await read("b.txt")).toBe("A");
    await v.redo();
    expect(await read("c.txt")).toBe("A");
    expect((await v.where("a.txt")).current).toBe("c.txt");
  });

  it("skips an occupied destination or a missing source, never overwrites", async () => {
    await write("a.txt", "A");
    await write("b.txt", "B");
    const v = await openVault(root);
    await v.moveMany([{ from: "a.txt", to: "x/a.txt" }, { from: "b.txt", to: "x/b.txt" }], "t");
    await v.undo({ batch: "t" });
    await write("x/a.txt", "someone else");
    await fs.rm(path.join(root, "b.txt"));
    const r = await v.redo({ batch: "t" });
    expect(r.redone).toEqual([]);
    expect(r.skipped.map((s) => [s.from, s.reason])).toEqual([["a.txt", "DEST_EXISTS"], ["b.txt", "MISSING"]]);
    expect(await read("x/a.txt")).toBe("someone else");
    expect(await read("a.txt")).toBe("A");
    expect(await fs.readdir(path.join(root, ".wasnew", "inflight"))).toEqual([]);
  });

  it("re-trashes into a fresh trash folder; undo brings it back", async () => {
    await write("junk/a.tmp", "J");
    const v = await openVault(root);
    const first = await v.trash("junk", "t");
    await v.undo({ batch: "t" });
    const r = await v.redo({ batch: "t" });
    expect(r.redone[0]).toMatchObject({ from: "junk", trashed: true });
    expect(r.redone[0].to).toMatch(/^trash\/[\w-]+\/junk$/);
    expect(await exists("junk")).toBe(false);
    expect(await fs.readFile(path.join(root, ".wasnew", r.redone[0].to, "a.tmp"), "utf8")).toBe("J");
    expect((await v.where("junk/a.tmp")).status).toBe("trashed");
    expect(first).toBeTruthy();
    await v.undo({ batch: "t" });
    expect(await read("junk/a.tmp")).toBe("J");
  });

  it("a redo group whose journal write failed is settled by recover", async () => {
    await write("a.txt", "A");
    await write("b.txt", "B");
    const v = await openVault(root);
    await v.moveMany([{ from: "a.txt", to: "s/a.txt" }, { from: "b.txt", to: "s/b.txt" }], "t");
    await v.undo({ batch: "t" });
    const real = fs.appendFile;
    const spy = vi.spyOn(fs, "appendFile").mockImplementationOnce(async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); });
    let r;
    try { r = await v.redo({ batch: "t" }); } finally { spy.mockRestore(); }
    expect(fs.appendFile).toBe(real);
    expect(r.skipped.map((s) => s.reason)).toEqual(["ENOSPC", "ENOSPC"]);
    expect(await read("s/a.txt")).toBe("A");   // renamed but not journaled: the marker stays
    expect(await fs.readdir(path.join(root, ".wasnew", "inflight"))).toHaveLength(1);

    const rec = await v.recover({ minAgeMs: 0 });
    expect(rec.map((i) => i.outcome)).toEqual(["journaled", "journaled"]);
    const redos = (await v.readJournal()).filter((e) => (e as any).redoOf);
    expect(redos.map((e) => [(e as any).redoOf, (e as any).recovered])).toEqual([[1, true], [2, true]]);
    expect((await v.where("a.txt")).current).toBe("s/a.txt");
    expect((await v.redo({ batch: "t" })).redone).toEqual([]);
    expect((await v.undo({ batch: "t" })).undone).toHaveLength(2);
    expect(await read("b.txt")).toBe("B");
  });

  it("does not count against maxOpsPerBatch; MCP wasnew_redo", async () => {
    await write("a.txt", "A");
    await write("b.txt", "B");
    await setPolicy({ maxOpsPerBatch: 2 });
    const v = await openVault(root);
    await v.moveMany([{ from: "a.txt", to: "s/a.txt" }, { from: "b.txt", to: "s/b.txt" }], "t");
    await v.undo({ batch: "t" });
    const [, redo] = await session([hello(), call(1, "wasnew_redo", { batch: "t", reason: "user changed their mind" })]);
    expect(redo.result.structuredContent).toMatchObject({ summary: ["2 × *.txt  ./ → s/"], skipped: [] });
    expect(redo.result.structuredContent.redone[0].by).toEqual({ agent: "claude-code", reason: "user changed their mind" });
    expect(await read("s/b.txt")).toBe("B");
  });
});

describe("agentName", () => {
  it("drops the client version so an update keeps the agent's record", () => {
    expect(agentName("claude-code 2.1.0")).toBe("claude-code");
    expect(agentName("codex v0.9.1-beta")).toBe("codex");
    expect(agentName("my agent")).toBe("my agent");
    expect(agentName(undefined)).toBe("");
  });
});
