import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openVault } from "./index.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "wasnew-where-"));
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "a.pdf"), "a\n");
  await fs.writeFile(path.join(root, "docs", "b.md"), "# b\n");
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const claude = { agent: "claude-code", reason: "sort" };

describe("where", () => {
  it("follows a chain of moves and says who did the last one", async () => {
    const v = await openVault(root);
    await v.move("a.pdf", "Docs/a.pdf", "t1", claude);
    await v.move("Docs/a.pdf", "Docs/2026/a.pdf", "t2", { agent: "other" });
    const w = await v.where("a.pdf");
    expect(w).toMatchObject({ path: "a.pdf", status: "moved", current: "Docs/2026/a.pdf", batch: "t2", by: { agent: "other" } });
    expect(w.steps.map((s) => [s.op, s.from, s.to])).toEqual([["move", "a.pdf", "Docs/a.pdf"], ["move", "Docs/a.pdf", "Docs/2026/a.pdf"]]);
    expect((await v.where("Docs/a.pdf")).current).toBe("Docs/2026/a.pdf");
  });

  it("carries a file along when its folder moves", async () => {
    const v = await openVault(root);
    await v.move("docs", "notes", "t1");
    expect(await v.where("docs/b.md")).toMatchObject({ status: "moved", current: "notes/b.md" });
    expect(await v.where("./docs/b.md")).toMatchObject({ status: "moved", current: "notes/b.md" });
    expect(await v.where(path.join(root, "docs", "b.md"))).toMatchObject({ status: "moved", current: "notes/b.md" });
  });

  it("an undo carries it back; the step that put it there skips undone ones", async () => {
    const v = await openVault(root);
    await v.move("a.pdf", "x/a.pdf", "t1", claude);
    await v.move("x/a.pdf", "y/a.pdf", "t2");
    await v.undo({ batch: "t2" });
    const w = await v.where("a.pdf");
    expect(w).toMatchObject({ status: "moved", current: "x/a.pdf", batch: "t1", by: claude });
    expect(w.steps.map((s) => s.op)).toEqual(["move", "move", "undo"]);
    await v.undo({ batch: "t1" });
    expect((await v.where("a.pdf")).status).toBe("here");
  });

  it("ends in the trash, and after the trash is emptied says purged", async () => {
    const v = await openVault(root);
    await v.move("a.pdf", "old/a.pdf", "t1");
    await v.trash("old", "t2");
    const w = await v.where("a.pdf");
    expect(w.status).toBe("trashed");
    expect(w.current).toMatch(/^trash\/[\w-]+\/old\/a\.pdf$/);
    expect(w.batch).toBe("t2");
    await v.emptyTrash({ olderThanDays: 0, dryRun: false });
    expect((await v.where("a.pdf")).status).toBe("purged");
  });

  it("an undone trash puts it back on the path", async () => {
    const v = await openVault(root);
    await v.trash("docs", "t1");
    expect((await v.where("docs/b.md")).status).toBe("trashed");
    await v.undo({ batch: "t1" });
    expect((await v.where("docs/b.md")).status).toBe("here");
  });

  it("unknown when nothing is recorded, missing when the recorded place is empty", async () => {
    const v = await openVault(root);
    expect(await v.where("nope.txt")).toEqual({ path: "nope.txt", status: "unknown", steps: [] });
    await v.move("a.pdf", "z/a.pdf");
    await fs.rm(path.join(root, "z", "a.pdf"));
    expect(await v.where("a.pdf")).toMatchObject({ status: "unknown", missing: true, current: "z/a.pdf" });
  });

  it("whereMany answers several paths from one journal read", async () => {
    const v = await openVault(root);
    await v.moveMany([{ from: "a.pdf", to: "s/a.pdf" }, { from: "docs/b.md", to: "s/b.md" }], "t1");
    expect((await v.whereMany(["a.pdf", "docs/b.md", "s/a.pdf"])).map((w) => w.current ?? w.status)).toEqual(["s/a.pdf", "s/b.md", "here"]);
  });

  it.runIf(process.platform === "win32" || process.platform === "darwin")("matches paths without case where the file system does", async () => {
    const v = await openVault(root);
    await v.move("a.pdf", "Docs/a.pdf");
    expect(await v.where("A.PDF")).toMatchObject({ status: "moved", current: "Docs/a.pdf" });
  });
});
