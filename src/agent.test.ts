import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

describe("group commit", () => {
  const files = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await fs.mkdir(path.join(root, "in", `d${i % 10}`), { recursive: true });
      await fs.writeFile(path.join(root, "in", `d${i % 10}`, `f${i}.txt`), `${i}\n`);
    }
    return Array.from({ length: n }, (_, i) => ({ from: `in/d${i % 10}/f${i}.txt`, to: `sorted/x${i % 7}/y${i % 3}/f${i}.txt` }));
  };
  const movesOf = async (v: Awaited<ReturnType<typeof openVault>>, batch: string) =>
    (await v.readJournal()).filter((e) => e.op === "move" && (e as any).batch === batch);
  const inflight = () => fs.readdir(path.join(root, ".wasnew", "inflight")).catch(() => []);

  it("moves 600 files in one call with consecutive seqs; undo brings all back and prunes empty folders", async () => {
    const moves = await files(600);
    const v = await openVault(root);
    await v.note("before");
    expect(await v.moveMany(moves, "g")).toEqual({ done: 600 });
    const seqs = (await movesOf(v, "g")).map((e) => e.seq);
    expect(seqs).toHaveLength(600);
    expect(seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1)).toBe(true);
    expect(await read("sorted/x3/y1/f10.txt")).toBe("10\n");
    expect(await inflight()).toEqual([]);

    const r = await v.undo({ batch: "g" });
    expect(r.undone).toHaveLength(600);
    expect(r.skipped).toHaveLength(0);
    for (const i of [0, 299, 599]) expect(await read(`in/d${i % 10}/f${i}.txt`)).toBe(`${i}\n`);
    await gone("sorted");
    expect(await v.pendingMoves("g")).toEqual([]);
  });

  it("stops at a taken destination mid-group; what came before is on disk, journaled and undoable", async () => {
    const moves = await files(600);
    await fs.mkdir(path.dirname(path.join(root, moves[299].to)), { recursive: true });
    await fs.writeFile(path.join(root, moves[299].to), "already here\n");
    const v = await openVault(root);
    const r = await v.moveMany(moves, "g");
    expect(r.done).toBe(299);
    expect(r.failed).toMatchObject({ index: 299, code: "DEST_EXISTS" });
    expect(await movesOf(v, "g")).toHaveLength(299);
    expect(await read(moves[298].to)).toBe("298\n");
    expect(await read(moves[299].from)).toBe("299\n");
    expect(await read(moves[299].to)).toBe("already here\n");
    expect(await read(moves[300].from)).toBe("300\n");
    expect(await inflight()).toEqual([]);

    expect((await v.undo({ batch: "g" })).undone).toHaveLength(299);
    expect(await read(moves[0].from)).toBe("0\n");
    expect(await read(moves[299].to)).toBe("already here\n");
  });

  it("counts ops done earlier in the same call against maxOpsPerBatch", async () => {
    const moves = await files(10);
    const v = await openVault(root);
    await setPolicy({ maxOpsPerBatch: 4 });
    const r = await v.moveMany(moves, "g");
    expect(r.done).toBe(4);
    expect(r.failed).toMatchObject({ index: 4, code: "POLICY_LIMIT" });
    expect(await read(moves[4].from)).toBe("4\n");
  });

  it("checks each op against what earlier ops of the call did", async () => {
    const v = await openVault(root);
    const r = await v.moveMany([
      { from: "a.txt", to: "x/a.txt" },
      { from: "docs/b.md", to: "x/a.txt" },   // would overwrite the file moved just before
    ], "g");
    expect(r).toMatchObject({ done: 1, failed: { index: 1, code: "DEST_EXISTS" } });
    expect(await read("x/a.txt")).toBe("hello\n");
    expect(await read("docs/b.md")).toBe("# b\n");
  });

  it("trashMany sets many aside and undo puts them back", async () => {
    const moves = await files(300);
    const v = await openVault(root);
    const r = await v.trashMany(moves.map((m) => m.from), "t");
    expect(r.done).toBe(300);
    expect(r.trashed).toHaveLength(300);
    expect(r.failed).toBeUndefined();
    expect(await fs.readFile(path.join(root, ".wasnew", r.trashed![7]), "utf8")).toBe("7\n");
    await gone(moves[7].from);
    expect((await v.undo({ batch: "t" })).undone).toHaveLength(300);
    expect(await read(moves[7].from)).toBe("7\n");
    expect(await fs.readdir(path.join(root, ".wasnew", "trash"))).toEqual([]);
  });

  it("recover reads a group marker and journals only the items that happened", async () => {
    const v = await openVault(root);
    const moves = await files(6);
    await fs.mkdir(path.join(root, "out"));
    const items = moves.map((m, i) => ({ src: path.join(root, m.from), dst: path.join(root, "out", `f${i}.txt`), entry: { op: "move", from: m.from, to: `out/f${i}.txt`, batch: "crashed" } }));
    // the process renamed the first three and died before the journal write
    for (const it of items.slice(0, 3)) await fs.rename(it.src, it.dst);
    // a chain inside the group: a.txt → out/a1.txt → out/a2.txt, both done
    await fs.rename(path.join(root, "a.txt"), path.join(root, "out", "a2.txt"));
    items.push(
      { src: path.join(root, "a.txt"), dst: path.join(root, "out", "a1.txt"), entry: { op: "move", from: "a.txt", to: "out/a1.txt", batch: "crashed" } },
      { src: path.join(root, "out", "a1.txt"), dst: path.join(root, "out", "a2.txt"), entry: { op: "move", from: "out/a1.txt", to: "out/a2.txt", batch: "crashed" } },
    );
    const dir = path.join(root, ".wasnew", "inflight");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "g.json"), JSON.stringify({ pid: 1, at: "2026-10-02T00:00:00.000Z", items }));
    // the old one-op format next to it
    await fs.rename(path.join(root, "docs", "b.md"), path.join(root, "b.md"));
    await fs.writeFile(path.join(dir, "old.json"), JSON.stringify({ pid: 1, at: "2026-10-02T00:00:00.000Z", src: path.join(root, "docs", "b.md"), dst: path.join(root, "b.md"), entry: { op: "move", from: "docs/b.md", to: "b.md", batch: "old" } }));
    const old = new Date(Date.now() - 60_000);
    for (const n of ["g.json", "old.json"]) await fs.utimes(path.join(dir, n), old, old);

    const r = await v.recover();
    expect(r.map((i) => i.outcome)).toEqual(expect.arrayContaining(["journaled", "not-started"]));
    expect(r.filter((i) => i.outcome === "journaled")).toHaveLength(6);
    expect(r.filter((i) => i.outcome === "not-started")).toHaveLength(3);
    expect(await v.pendingMoves("crashed")).toHaveLength(5);
    expect(await v.pendingMoves("old")).toHaveLength(1);
    expect(await fs.readdir(dir)).toEqual([]);

    expect((await v.undo({ batch: "crashed" })).undone).toHaveLength(5);
    expect(await read("a.txt")).toBe("hello\n");
    expect(await read(moves[2].from)).toBe("2\n");
    await v.undo({ batch: "old" });
    expect(await read("docs/b.md")).toBe("# b\n");
  });

  it("recover skips marker items that looked done before the group ran", async () => {
    const v = await openVault(root);
    // a group listing a move whose destination already existed and whose source did not;
    // it would have failed with DEST_EXISTS, so recover must not journal it
    await fs.writeFile(path.join(root, "taken.txt"), "someone else\n");
    const dir = path.join(root, ".wasnew", "inflight");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "g.json"), JSON.stringify({ pid: 1, at: "x", items: [
      { src: path.join(root, "ghost.txt"), dst: path.join(root, "taken.txt"), entry: { op: "move", from: "ghost.txt", to: "taken.txt" }, looksDone: true },
    ] }));
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(path.join(dir, "g.json"), old, old);
    expect((await v.recover()).map((i) => i.outcome)).toEqual(["not-started"]);
    expect(await v.pendingMoves()).toEqual([]);
  });

  it("trashMany puts a whole group in one trash folder", async () => {
    const moves = await files(300);
    const v = await openVault(root);
    const r = await v.trashMany(moves.map((m) => m.from), "t");
    expect(new Set(r.trashed!.map((t) => t.split("/")[1])).size).toBe(2);   // 256 + 44
    expect(await fs.readdir(path.join(root, ".wasnew", "trash"))).toHaveLength(2);
  });

  it("gives a fresh trash folder to a path that would collide inside the group", async () => {
    const v = await openVault(root);
    await fs.writeFile(path.join(root, "c.txt"), "second a\n");
    const plan = await v.plan([
      { op: "trash", path: "a.txt" },
      { op: "move", from: "c.txt", to: "a.txt" },
      { op: "trash", path: "a.txt" },            // same path again
      { op: "trash", path: "docs/b.md" },
      { op: "trash", path: "docs" },             // holds the one before
      { op: "trash", path: "Taxes/2025.pdf" },   // no clash: shares the first folder
    ]);
    expect(plan.issues).toEqual([]);
    expect((await v.apply(plan.id)).done).toBe(6);
    const tos = (await v.readJournal()).filter((e) => e.op === "trash").map((e) => (e as any).to as string);
    const ids = tos.map((t) => t.split("/")[1]);
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids[3]).not.toBe(ids[2]);
    expect(ids[4]).toBe(ids[0]);
    expect(new Set(tos).size).toBe(5);
    expect(await fs.readFile(path.join(root, ".wasnew", tos[0]), "utf8")).toBe("hello\n");
    expect(await fs.readFile(path.join(root, ".wasnew", tos[1]), "utf8")).toBe("second a\n");

    expect((await v.undo({ batch: "plan-" + plan.id })).undone).toHaveLength(6);
    expect(await read("a.txt")).toBe("hello\n");
    expect(await read("c.txt")).toBe("second a\n");
    expect(await read("docs/b.md")).toBe("# b\n");
    expect(await read("Taxes/2025.pdf")).toBe("tax\n");
    expect(await fs.readdir(path.join(root, ".wasnew", "trash"))).toEqual([]);
    expect((await v.history("a.txt")).filter((e) => e.op === "trash")).toHaveLength(2);
  });

  /** Makes the process "die" right after the inflight marker is written: nothing renamed, marker left behind */
  async function crashAfterMarker(run: () => Promise<unknown>): Promise<any[]> {
    const real = fs.writeFile;
    const markers: any[] = [];
    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (p: any, data: any, ...rest: any[]) => {
      await (real as any)(p, data, ...rest);
      if (String(p).includes(`${path.sep}inflight${path.sep}`)) { markers.push(JSON.parse(String(data))); throw new Error("crash"); }
    });
    try {
      await expect(run()).rejects.toThrow("crash");
    } finally { spy.mockRestore(); }
    const dir = path.join(root, ".wasnew", "inflight");
    const old = new Date(Date.now() - 60_000);
    for (const n of await fs.readdir(dir)) await fs.utimes(path.join(dir, n), old, old);
    return markers;
  }

  it("a single op that fails its check writes no marker", async () => {
    const v = await openVault(root);
    const spy = vi.spyOn(fs, "writeFile");
    try {
      await expect(v.move("a.txt", "docs/b.md")).rejects.toMatchObject({ code: "DEST_EXISTS" });
      await expect(v.trash("ghost.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(spy.mock.calls.filter(([p]) => String(p).includes(`${path.sep}inflight${path.sep}`))).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it("a crash right after the marker: items that looked done are flagged and recover journals nothing", async () => {
    const v = await openVault(root);
    await fs.writeFile(path.join(root, "taken.txt"), "someone else\n");
    const [marker] = await crashAfterMarker(() => v.moveMany([
      { from: "a.txt", to: "x/a.txt" },
      { from: "ghost.txt", to: "taken.txt" },   // would fail with DEST_EXISTS, but looks done on disk
    ], "g"));
    expect(marker.items.map((it: any) => it.looksDone ?? false)).toEqual([false, true]);
    expect((await v.recover()).map((i) => i.outcome)).toEqual(["not-started", "not-started"]);
    expect(await v.pendingMoves()).toEqual([]);
    expect(await read("a.txt")).toBe("hello\n");
  });

  it("an undo whose first item fails its check flags it, so recover never journals it", async () => {
    const v = await openVault(root);
    await v.move("docs/b.md", "y.md", "b");
    await v.move("a.txt", "z.txt", "b");
    // the undo of a.txt → z.txt now looks done: z.txt is gone and something sits at a.txt
    await fs.rm(path.join(root, "z.txt"));
    await fs.writeFile(path.join(root, "a.txt"), "new a\n");
    const [marker] = await crashAfterMarker(() => v.undo({ batch: "b" }));
    expect(marker.items.map((it: any) => it.looksDone ?? false)).toEqual([true, false]);
    expect((await v.recover()).map((i) => i.outcome)).toEqual(["not-started", "not-started"]);
    expect(await v.pendingMoves("b")).toHaveLength(2);
    expect(await read("a.txt")).toBe("new a\n");
  });
});
