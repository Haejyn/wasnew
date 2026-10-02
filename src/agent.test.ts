import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openVault, parsePolicy } from "./index.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "wasnew-agent-"));
  await fs.mkdir(path.join(root, "docs"));
  await fs.mkdir(path.join(root, "Taxes"));
  await fs.writeFile(path.join(root, "a.txt"), "hello\n");
  await fs.writeFile(path.join(root, "docs", "b.md"), "# b\n");
  await fs.writeFile(path.join(root, "Taxes", "2025.pdf"), "tax\n");
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const read = (rel: string) => fs.readFile(path.join(root, rel), "utf8");
const gone = (rel: string) => expect(fs.access(path.join(root, rel))).rejects.toThrow();
const setPolicy = (p: object) => fs.writeFile(path.join(root, ".wasnew", "policy.json"), JSON.stringify(p));
const claude = { agent: "claude-code 2.1", model: "test-model", reason: "tidy Downloads" };

describe("trash", () => {
  it("sets files and folders aside instead of deleting; undo brings them back", async () => {
    const v = await openVault(root);
    const where = await v.trash("a.txt", "t1", claude);
    await v.trash("docs", "t1");
    await gone("a.txt");
    await gone("docs");
    expect(where).toMatch(/^trash\/[\w-]+\/a\.txt$/);
    expect(await fs.readFile(path.join(root, ".wasnew", where), "utf8")).toBe("hello\n");
    expect((await v.pendingMoves("t1")).map((m) => m.trashed)).toEqual([true, true]);

    const r = await v.undo({ batch: "t1" });
    expect(r.undone).toHaveLength(2);
    expect(await read("a.txt")).toBe("hello\n");
    expect(await read("docs/b.md")).toBe("# b\n");
    expect(await fs.readdir(path.join(root, ".wasnew", "trash"))).toEqual([]);   // emptied folders tidied
  });

  it("trashed files never show up in snapshots, and the root itself cannot be trashed", async () => {
    const v = await openVault(root);
    await v.trash("a.txt");
    const s = await v.get((await v.snapshot()).id);
    expect(s.files.map((f) => f.path)).not.toContain("a.txt");
    await expect(v.trash(".")).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(v.trash("nope.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("only emptyTrash really deletes — dry run first, and only what is old enough", async () => {
    const v = await openVault(root);
    await v.trash("a.txt", "t1");
    expect(await v.emptyTrash({ olderThanDays: 1 })).toMatchObject({ entries: [] });
    const dry = await v.emptyTrash({ olderThanDays: 0 });
    expect(dry).toMatchObject({ dryRun: true, bytes: 6, entries: [{ from: "a.txt" }] });
    expect(await v.pendingMoves()).toHaveLength(1);

    await v.emptyTrash({ olderThanDays: 0, dryRun: false });
    expect(await v.pendingMoves()).toHaveLength(0);                  // purged trash is no longer undoable
    expect(await fs.readdir(path.join(root, ".wasnew", "trash"))).toEqual([]);
    expect((await v.undo({ batch: "t1" })).undone).toHaveLength(0);
  });
});

describe("who and why", () => {
  it("keeps the actor on every entry and traces a file through its names", async () => {
    const v = await openVault(root);
    await v.move("a.txt", "notes/a.txt", "run-1", claude);
    await v.move("notes/a.txt", "notes/hello.txt", "run-2", { agent: "cursor", reason: "rename" });
    await v.note("open", { path: "notes/hello.txt" });
    await v.undo({ batch: "run-2", by: { agent: "person" } });
    const h = await v.history("a.txt");
    expect(h.map((e) => e.op)).toEqual(["move", "move", "open", "undo"]);
    expect(h[0]).toMatchObject({ from: "a.txt", to: "notes/a.txt", batch: "run-1", by: claude });
    expect(h[1]).toMatchObject({ by: { agent: "cursor", reason: "rename" }, undone: true });
    expect(h[3].by).toEqual({ agent: "person" });
    expect(await v.history("notes/a.txt")).toHaveLength(4);         // same lineage, asked by a later name
    expect(await v.history("docs/b.md")).toEqual([]);
  });
});

describe("policy", () => {
  it("protects paths, including folders that hold them", async () => {
    const v = await openVault(root);
    await setPolicy({ protect: ["Taxes/", "*.key"] });
    await fs.writeFile(path.join(root, "docs", "id.key"), "k");
    await expect(v.move("Taxes/2025.pdf", "x.pdf")).rejects.toMatchObject({ code: "POLICY_PROTECTED" });
    await expect(v.move("a.txt", "Taxes/a.txt")).rejects.toMatchObject({ code: "POLICY_PROTECTED" });
    await expect(v.trash("docs")).rejects.toMatchObject({ code: "POLICY_PROTECTED" });   // holds id.key
    await v.move("a.txt", "docs/a.txt");                                                  // the rest still works
    expect(await read("Taxes/2025.pdf")).toBe("tax\n");
  });

  it("caps a batch, can turn trash off, and fails closed when malformed", async () => {
    const v = await openVault(root);
    await setPolicy({ maxOpsPerBatch: 1, allowTrash: false });
    await v.move("a.txt", "a2.txt", "b");
    await expect(v.move("docs/b.md", "b.md", "b")).rejects.toMatchObject({ code: "POLICY_LIMIT" });
    await v.move("docs/b.md", "b.md", "other");
    await expect(v.trash("b.md")).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await fs.writeFile(path.join(root, ".wasnew", "policy.json"), "{ nope");
    await expect(v.move("b.md", "c.md")).rejects.toMatchObject({ code: "POLICY_INVALID" });
  });

  it("rejects unknown keys and bad values", () => {
    expect(() => parsePolicy({ protectt: [] })).toThrow(/unknown policy keys/);
    expect(() => parsePolicy({ maxOpsPerBatch: -1 })).toThrow();
    expect(() => parsePolicy([])).toThrow();
    expect(parsePolicy({ protect: ["a/"] }).isProtected("a/b.txt")).toBe(true);
  });
});

describe("plan → approve → apply", () => {
  it("finds problems before anything moves, following earlier steps of the plan", async () => {
    const v = await openVault(root);
    await setPolicy({ protect: ["Taxes/"] });
    const plan = await v.plan([
      { op: "move", from: "a.txt", to: "notes/a.txt" },
      { op: "move", from: "notes/a.txt", to: "notes/hello.txt" },   // fine: the step before created it
      { op: "move", from: "a.txt", to: "x.txt" },                   // already moved away by step 0
      { op: "move", from: "docs/b.md", to: "notes/hello.txt" },     // taken by step 1
      { op: "trash", path: "Taxes/2025.pdf" },
      { op: "delete", path: "a.txt" } as any,
    ]);
    expect(plan.issues.map((i) => [i.index, i.code])).toEqual([[2, "NOT_FOUND"], [3, "DEST_EXISTS"], [4, "POLICY_PROTECTED"], [5, "PLAN_INVALID"]]);
    expect(await read("a.txt")).toBe("hello\n");
    await expect(v.apply(plan.id)).rejects.toMatchObject({ code: "PLAN_INVALID" });
  });

  it("big plans wait for a person; apply runs exactly once as one undoable batch", async () => {
    const v = await openVault(root);
    await setPolicy({ requireApprovalOver: 1 });
    const plan = await v.plan([
      { op: "move", from: "a.txt", to: "notes/a.txt" },
      { op: "trash", path: "docs/b.md" },
    ], { by: claude });
    expect(plan.needsApproval).toBe(true);
    await expect(v.apply(plan.id)).rejects.toMatchObject({ code: "NEEDS_APPROVAL" });

    await v.approve(plan.id, "haejyn");
    const r = await v.apply(plan.id);
    expect(r).toEqual({ plan: plan.id, batch: "plan-" + plan.id, done: 2 });
    expect(await read("notes/a.txt")).toBe("hello\n");
    expect((await v.pendingMoves(r.batch))[0].by).toEqual(claude);
    await expect(v.apply(plan.id)).rejects.toMatchObject({ code: "PLAN_APPLIED" });
    await expect(v.approve(plan.id)).rejects.toMatchObject({ code: "PLAN_APPLIED" });

    await v.undo({ batch: r.batch });
    expect(await read("a.txt")).toBe("hello\n");
    expect(await read("docs/b.md")).toBe("# b\n");
    expect((await v.plans()).map((p) => p.id)).toEqual([plan.id]);
  });

  it("refuses when the folder changed since the plan", async () => {
    const v = await openVault(root);
    const plan = await v.plan([{ op: "move", from: "a.txt", to: "b.txt" }]);
    await fs.writeFile(path.join(root, "b.txt"), "someone else\n");
    await expect(v.apply(plan.id)).rejects.toMatchObject({ code: "PLAN_INVALID" });
    expect(await read("a.txt")).toBe("hello\n");
    await expect(v.getPlan("../../x")).rejects.toMatchObject({ code: "PLAN_NOT_FOUND" });
  });
});

describe("recover", () => {
  const marker = async (name: string, body: object, ageMs = 60_000) => {
    const dir = path.join(root, ".wasnew", "inflight");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await fs.writeFile(file, JSON.stringify(body));
    const t = new Date(Date.now() - ageMs);
    await fs.utimes(file, t, t);
  };

  it("journals a move that happened but was never written down, so it can be undone", async () => {
    const v = await openVault(root);
    // the process renamed a.txt and died before appending to the journal
    await fs.mkdir(path.join(root, "sorted"));
    await fs.rename(path.join(root, "a.txt"), path.join(root, "sorted", "a.txt"));
    await marker("1.json", { at: "2026-10-02T00:00:00.000Z", src: path.join(root, "a.txt"), dst: path.join(root, "sorted", "a.txt"), entry: { op: "move", from: "a.txt", to: "sorted/a.txt", batch: "crashed" } });
    // one that never started, one that is still fresh
    await marker("2.json", { at: "x", src: path.join(root, "docs", "b.md"), dst: path.join(root, "b.md"), entry: { op: "move", from: "docs/b.md", to: "b.md" } });
    await marker("3.json", { at: "x", src: path.join(root, "q"), dst: path.join(root, "r"), entry: { op: "move", from: "q", to: "r" } }, 0);

    const items = await v.recover();
    expect(items.map((i) => i.outcome).sort()).toEqual(["in-progress", "journaled", "not-started"]);
    expect(await v.pendingMoves("crashed")).toHaveLength(1);
    await v.undo({ batch: "crashed" });
    expect(await read("a.txt")).toBe("hello\n");
    expect(await fs.readdir(path.join(root, ".wasnew", "inflight"))).toEqual(["3.json"]);
  });

  it("leaves no markers behind on normal or failed moves", async () => {
    const v = await openVault(root);
    await v.move("a.txt", "x.txt");
    await expect(v.move("nope", "y.txt")).rejects.toThrow();
    expect(await fs.readdir(path.join(root, ".wasnew", "inflight"))).toEqual([]);
  });
});
