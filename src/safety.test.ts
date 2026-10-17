import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openVault, isWasnewError } from "./index.js";

let base: string, root: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "wasnew-safety-"));
  root = path.join(base, "root");
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(path.join(root, "a.txt"), "hello\n");
  await fs.writeFile(path.join(root, "docs", "b.md"), "# b\n");
});
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

const exdev = () => Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
const read = (rel: string) => fs.readFile(path.join(root, rel), "utf8");

describe("undo across volumes", () => {
  it("brings back a file that crossed drives (rename fails with EXDEV on the way back too)", async () => {
    const src = path.join(base, "Downloads");
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, "big.mov"), "frames\n");
    const v = await openVault(root);
    const real = fs.rename;
    // every direct rename between the two "drives" fails; tmp → final inside one drive works
    (fs as any).rename = async (a: string, b: string) => {
      if (path.basename(a).includes("wasnew-tmp")) return real(a, b);
      throw exdev();
    };
    try {
      await v.move(path.join(src, "big.mov"), "media/big.mov", "b1");
      const r = await v.undo({ batch: "b1" });
      expect(r.undone).toHaveLength(1);
      expect(r.skipped).toHaveLength(0);
    } finally { (fs as any).rename = real; }
    expect(await fs.readFile(path.join(src, "big.mov"), "utf8")).toBe("frames\n");
    await expect(fs.access(path.join(root, "media"))).rejects.toThrow();
  });

  it("reports why a move was not undone instead of skipping silently", async () => {
    const v = await openVault(root);
    await v.move("a.txt", "docs/a.txt", "b1");
    await v.move("docs/b.md", "b.md", "b1");
    await fs.writeFile(path.join(root, "a.txt"), "usurper\n");
    await fs.rm(path.join(root, "b.md"));
    const r = await v.undo({ batch: "b1" });
    expect(r.undone).toHaveLength(0);
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(["MISSING", "ORIGIN_OCCUPIED"]);
    expect(await read("a.txt")).toBe("usurper\n");
  });
});

describe("restore guard", () => {
  it("snapshots what it overwrites, so the restore itself can be undone", async () => {
    const v = await openVault(root);
    const s = await v.snapshot({ label: "before" });
    await fs.writeFile(path.join(root, "a.txt"), "today's work\n");
    const r = await v.restore(s.id);
    expect(r.restored).toBe(1);
    expect(r.guard).toBeDefined();
    expect(await read("a.txt")).toBe("hello\n");

    const guard = await v.get(r.guard!);
    expect(guard.partial).toBe(true);
    expect(guard.files.map((f) => f.path)).toEqual(["a.txt"]);   // only what was overwritten
    await v.restore(r.guard!);
    expect(await read("a.txt")).toBe("today's work\n");
  });

  it("takes no guard when nothing is overwritten, or when told not to", async () => {
    const v = await openVault(root);
    const s = await v.snapshot();
    expect((await v.restore(s.id)).guard).toBeUndefined();          // nothing changed
    await fs.writeFile(path.join(root, "a.txt"), "x\n");
    expect((await v.restore(s.id, { guard: false })).guard).toBeUndefined();
    expect((await v.log()).length).toBe(1);
  });

  it("recreates a missing file without needing a guard", async () => {
    const v = await openVault(root);
    const s = await v.snapshot();
    await fs.rm(path.join(root, "docs", "b.md"));
    const r = await v.restore(s.id, { paths: ["docs/b.md"] });
    expect(r).toMatchObject({ restored: 1 });
    expect(r.guard).toBeUndefined();
    expect(await read("docs/b.md")).toBe("# b\n");
  });
});

describe("snapshot streams", () => {
  it("never reads a large user file whole into memory (small ones are read in one go)", async () => {
    await fs.writeFile(path.join(root, "big.bin"), Buffer.alloc(4 * 1024 ** 2 + 1, 7));
    const v = await openVault(root);
    const real = fs.readFile;
    const whole: string[] = [];
    (fs as any).readFile = async (p: any, ...rest: any[]) => {
      if (typeof p === "string" && !p.includes(`${path.sep}.wasnew${path.sep}`)) whole.push(p);
      return (real as any)(p, ...rest);
    };
    try {
      await v.snapshot();
    } finally { (fs as any).readFile = real; }
    expect(whole.filter((p) => p.endsWith("big.bin"))).toEqual([]);
    expect(whole.filter((p) => p.endsWith("a.txt"))).toHaveLength(1);
    const s = await v.get((await v.log())[0].id);
    expect(s.files.find((f) => f.path === "big.bin")?.size).toBe(4 * 1024 ** 2 + 1);
  });

  it("stores the same content once and leaves no temp files", async () => {
    const v = await openVault(root);
    await fs.writeFile(path.join(root, "copy.txt"), "hello\n");
    const s = await v.snapshot();
    expect(s.newBlobs).toBe(2);
    expect(await fs.readdir(path.join(root, ".wasnew", "tmp"))).toEqual([]);
  });
});

describe("concurrent snapshots", () => {
  it("a blob another writer placed first counts as stored when the rename onto it is refused", async () => {
    const v = await openVault(root);
    const real = fs.rename;
    let refused = 0;
    // the other writer wins the race, then Windows refuses to rename onto its blob
    (fs as any).rename = async (a: string, b: string) => {
      if (b.includes(`${path.sep}objects${path.sep}`) && refused === 0) {
        refused++;
        await fs.copyFile(a, b);
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      }
      return real(a, b);
    };
    let s;
    try { s = await v.snapshot(); } finally { (fs as any).rename = real; }
    expect(refused).toBe(1);
    expect(s.newBlobs).toBe(1);
    expect(await fs.readdir(path.join(root, ".wasnew", "tmp"))).toEqual([]);
    expect((await v.readSnapshotFile(s.id, "a.txt")).toString()).toBe("hello\n");
    expect((await v.readSnapshotFile(s.id, "docs/b.md")).toString()).toBe("# b\n");
  });

  it("two snapshots of the same new files at once leave intact blobs and no temp files", async () => {
    for (let i = 0; i < 40; i++) await fs.writeFile(path.join(root, `f${i}.txt`), `same ${i % 10}\n`);
    const [v1, v2] = await Promise.all([openVault(root), openVault(root)]);
    const [s1, s2] = await Promise.all([v1.snapshot(), v2.snapshot()]);
    expect(await fs.readdir(path.join(root, ".wasnew", "tmp"))).toEqual([]);
    for (const snap of [s1, s2]) {
      expect(snap.fileCount).toBe(42);
      for (const f of (await v1.get(snap.id)).files) expect((await v1.readSnapshotFile(snap.id, f.path)).toString()).toBe(await read(f.path));
    }
  });
});

describe("journal lock", () => {
  it("two writers never hand out the same seq", async () => {
    for (let i = 0; i < 30; i++) await fs.writeFile(path.join(root, `f${i}.txt`), String(i));
    const [v1, v2] = await Promise.all([openVault(root), openVault(root)]);   // two "processes"
    await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? v1 : v2).move(`f${i}.txt`, `sorted/f${i}.txt`, "b")));
    const seqs = (await v1.readJournal()).map((e) => e.seq);
    expect(new Set(seqs).size).toBe(30);
    const r = await v2.undo({ batch: "b" });
    expect(r.undone).toHaveLength(30);
    await expect(fs.access(path.join(root, ".wasnew", "journal.lock"))).rejects.toThrow();
  });

  it("takes over a lock left by a crashed process", async () => {
    const v = await openVault(root);
    const lock = path.join(root, ".wasnew", "journal.lock");
    await fs.writeFile(lock, "999999 crashed\n");
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    await v.move("a.txt", "z.txt");
    expect(await v.pendingMoves()).toHaveLength(1);
  });
});

describe("ignore", () => {
  it("honours .wasnewignore and extra ignore names", async () => {
    await fs.writeFile(path.join(root, ".wasnewignore"), "*.log\nbuild/\n!keep.log\n");
    await fs.mkdir(path.join(root, "build"));
    await fs.writeFile(path.join(root, "build", "out.bin"), "x");
    await fs.writeFile(path.join(root, "debug.log"), "x");
    await fs.writeFile(path.join(root, "keep.log"), "x");
    await fs.mkdir(path.join(root, ".app"));
    await fs.writeFile(path.join(root, ".app", "state.json"), "{}");
    const v = await openVault(root, { ignore: [".app"] });
    const s = await v.get((await v.snapshot()).id);
    expect(s.files.map((f) => f.path)).toEqual([".wasnewignore", "a.txt", "docs/b.md", "keep.log"]);
  });
});

describe("diff", () => {
  it("tells added, changed, missing and moved apart", async () => {
    const v = await openVault(root);
    const s = await v.snapshot();
    await fs.writeFile(path.join(root, "a.txt"), "changed\n");
    await fs.rename(path.join(root, "docs", "b.md"), path.join(root, "b.md"));
    await fs.writeFile(path.join(root, "new.txt"), "new\n");
    const now = await v.diff(s.id);
    expect(now).toEqual({ added: ["new.txt"], changed: ["a.txt"], missing: [], moved: [{ from: "docs/b.md", to: "b.md" }] });
    await fs.rm(path.join(root, "new.txt"));
    await fs.rm(path.join(root, "b.md"));
    const s2 = await v.snapshot();
    expect(await v.diff(s.id, s2.id)).toEqual({ added: [], changed: ["a.txt"], missing: ["docs/b.md"], moved: [] });
  });
});

describe("gc", () => {
  it("needs a policy, dry-runs by default and never touches user files", async () => {
    const v = await openVault(root);
    await expect(v.gc({})).rejects.toMatchObject({ code: "GC_NEEDS_POLICY" });
    const old = await v.snapshot({ label: "old" });
    await fs.writeFile(path.join(root, "a.txt"), "v2\n");
    await v.snapshot({ label: "new" });
    // age every blob past the grace period
    const objects = path.join(root, ".wasnew", "objects");
    const past = new Date(Date.now() - 3_600_000);
    for (const d of await fs.readdir(objects)) for (const f of await fs.readdir(path.join(objects, d))) await fs.utimes(path.join(objects, d, f), past, past);

    const dry = await v.gc({ keepLast: 1 });
    expect(dry).toMatchObject({ dryRun: true, snapshots: [old.id], blobs: 1 });
    expect((await v.log()).length).toBe(2);

    const real = await v.gc({ keepLast: 1, dryRun: false });
    expect(real.blobs).toBe(1);
    expect((await v.log()).map((s) => s.label)).toEqual(["new"]);
    expect(await read("a.txt")).toBe("v2\n");
    expect(await read("docs/b.md")).toBe("# b\n");
  });

  it("keeps the blobs the stat cache relies on when the cache's snapshot is dropped", async () => {
    const t = new Date(Date.now() - 60_000);
    for (const rel of ["a.txt", "docs/b.md"]) await fs.utimes(path.join(root, rel), t, t);   // past the racy window
    const v = await openVault(root);
    const cached = await v.snapshot({ label: "cached" });
    // a newer snapshot that is not the cache's, so keepLast 1 drops the one the cache names
    await v.importSnapshot("imported", new Date(Date.now() + 60_000).toISOString(), "imported", [{ path: "other.txt", content: Buffer.from("x") }]);
    const objects = path.join(root, ".wasnew", "objects");
    const past = new Date(Date.now() - 3_600_000);
    for (const d of await fs.readdir(objects)) for (const f of await fs.readdir(path.join(objects, d))) await fs.utimes(path.join(objects, d, f), past, past);

    const r = await v.gc({ keepLast: 1, dryRun: false });
    expect(r).toMatchObject({ snapshots: [cached.id], blobs: 0 });
    const s = await v.snapshot();
    expect(s.hashed).toBe(0);                                          // the cache still answered
    expect((await v.readSnapshotFile(s.id, "a.txt")).toString()).toBe("hello\n");
    expect((await v.readSnapshotFile(s.id, "docs/b.md")).toString()).toBe("# b\n");
  });

  it("always keeps the newest snapshot and young blobs", async () => {
    const v = await openVault(root);
    await v.snapshot();
    const r = await v.gc({ olderThanDays: 0, dryRun: false });
    expect(r).toMatchObject({ snapshots: [], blobs: 0 });
    expect((await v.log()).length).toBe(1);
  });
});

describe("errors and notes", () => {
  it("refuses snapshot ids that could escape the store", async () => {
    const v = await openVault(root);
    await expect(v.get("../../etc/passwd")).rejects.toMatchObject({ code: "BAD_SNAPSHOT_ID" });
    await expect(v.get("nope")).rejects.toMatchObject({ code: "SNAPSHOT_NOT_FOUND" });
    const s = await v.snapshot();
    await expect(v.readSnapshotFile(s.id, "zzz.txt")).rejects.toMatchObject({ code: "NOT_IN_SNAPSHOT" });
  });

  it("records app events but keeps move/undo/restore reserved", async () => {
    const v = await openVault(root);
    await v.note("open", { path: "a.txt" });
    await expect(v.note("move", {})).rejects.toSatisfy((e) => isWasnewError(e, "RESERVED_OP"));
    expect(await v.readJournal()).toMatchObject([{ seq: 1, op: "open", path: "a.txt" }]);
  });
});
