import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openVault, type SnapshotResult } from "./index.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "wasnew-watch-"));
  await fs.writeFile(path.join(root, "a.txt"), "hello\n");
  await fs.writeFile(path.join(root, "b.txt"), "bee\n");
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

/** pretend the files were last written a minute ago, past the racy window */
async function age(...rels: string[]) {
  const t = new Date(Date.now() - 60_000);
  for (const rel of rels) await fs.utimes(path.join(root, rel), t, t);
}

describe("stat cache", () => {
  it("does not re-read files whose size and mtime did not change", async () => {
    await age("a.txt", "b.txt");
    const v = await openVault(root);
    expect((await v.snapshot()).hashed).toBe(2);
    expect((await v.snapshot()).hashed).toBe(0);
    await fs.writeFile(path.join(root, "a.txt"), "changed!\n");
    const s = await v.snapshot();
    expect(s.hashed).toBe(1);
    expect((await v.readSnapshotFile(s.id, "a.txt")).toString()).toBe("changed!\n");
  });

  it("re-reads files written just before the last snapshot (same-tick edits keep their mtime)", async () => {
    const v = await openVault(root);                       // files are fresh: inside the racy window
    await v.snapshot();
    const mtime = (await fs.stat(path.join(root, "a.txt"))).mtime;
    await fs.writeFile(path.join(root, "a.txt"), "HELLO\n");  // same size
    await fs.utimes(path.join(root, "a.txt"), mtime, mtime);  // and the same mtime
    const s = await v.snapshot();
    expect((await v.readSnapshotFile(s.id, "a.txt")).toString()).toBe("HELLO\n");
  });

  it("trusts cache hits without checking each blob while the cache's snapshot exists", async () => {
    await age("a.txt", "b.txt");
    const v = await openVault(root);
    await v.snapshot();
    const spy = vi.spyOn(fs, "access");
    try {
      expect((await v.snapshot()).hashed).toBe(0);
      expect(spy.mock.calls.filter(([p]) => String(p).includes(`${path.sep}objects${path.sep}`))).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it("checks each blob when the cache's snapshot is gone, and re-reads a file whose blob is missing", async () => {
    await age("a.txt", "b.txt");
    const v = await openVault(root);
    const s1 = await v.snapshot();
    const blob = (await v.get(s1.id)).files.find((f) => f.path === "a.txt")!.hash;
    await fs.rm(path.join(root, ".wasnew", "snapshots", s1.id + ".json"));
    await fs.rm(path.join(root, ".wasnew", "objects", blob.slice(0, 2), blob.slice(2)));
    const s2 = await v.snapshot();
    expect(s2).toMatchObject({ hashed: 1, newBlobs: 1 });
    expect((await v.readSnapshotFile(s2.id, "a.txt")).toString()).toBe("hello\n");
  });

  it("rehash ignores the cache", async () => {
    await age("a.txt", "b.txt");
    const v = await openVault(root);
    await v.snapshot();
    expect((await v.snapshot({ rehash: true })).hashed).toBe(2);
  });
});

describe("skipIfUnchanged", () => {
  it("returns the last snapshot instead of an identical new one", async () => {
    const v = await openVault(root);
    const first = await v.snapshot();
    const again = await v.snapshot({ skipIfUnchanged: true });
    expect(again).toMatchObject({ id: first.id, unchanged: true });
    await fs.writeFile(path.join(root, "c.txt"), "new\n");
    const third = await v.snapshot({ skipIfUnchanged: true });
    expect(third.unchanged).toBeUndefined();
    expect((await v.log()).length).toBe(2);
  });
});

describe("watch", () => {
  it("snapshots after changes settle, once per burst, and stops on abort", async () => {
    const v = await openVault(root);
    await v.snapshot();
    const taken: SnapshotResult[] = [];
    const ac = new AbortController();
    const done = v.watch({ signal: ac.signal, debounceMs: 150, onSnapshot: (s) => taken.push(s) });
    await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 5; i++) await fs.writeFile(path.join(root, `burst-${i}.txt`), String(i));
    await fs.mkdir(path.join(root, "sub"));
    await fs.writeFile(path.join(root, "sub", "deep.txt"), "deep");
    for (let t = 0; t < 50 && taken.length === 0; t++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 400));
    ac.abort();
    await done;
    expect(taken).toHaveLength(1);
    const files = (await v.get(taken[0].id)).files.map((f) => f.path);
    expect(files).toContain("sub/deep.txt");
    expect(files.filter((f) => f.startsWith("burst-"))).toHaveLength(5);
  });

  it("ignores its own store", async () => {
    const v = await openVault(root);
    await v.snapshot();
    const taken: SnapshotResult[] = [];
    const ac = new AbortController();
    const done = v.watch({ signal: ac.signal, debounceMs: 100, onSnapshot: (s) => taken.push(s) });
    await new Promise((r) => setTimeout(r, 100));
    await v.note("open", { path: "a.txt" });               // writes .wasnew/journal.jsonl
    await new Promise((r) => setTimeout(r, 400));
    ac.abort();
    await done;
    expect(taken).toEqual([]);
  });
});
