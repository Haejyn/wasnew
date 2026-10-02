/**
 * 이동의 출발점은 루트 **밖**이어도 된다 — 다운로드에서 작업 폴더로 가져오는 일이 흔하다.
 * 되돌리면 다운로드로 돌아가야 한다. 도착점은 여전히 루트 안만.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openVault } from "./index.js";

let base: string, root: string, src: string;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "wasnew-src-"));
  root = path.join(base, "Workspace");
  src = path.join(base, "Downloads");
  await fs.mkdir(root); await fs.mkdir(src);
  await fs.writeFile(path.join(src, "a.txt"), "a\n");
});
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

describe("루트 밖 소스에서 담기", () => {
  it("절대 경로로 온 파일이 루트 안으로 들어오고, 되돌리면 소스로 돌아간다", async () => {
    const v = await openVault(root);
    const from = path.join(src, "a.txt").replaceAll("\\", "/");
    await v.move(from, "문서/a.txt", "b1");
    expect(await fs.readFile(path.join(root, "문서", "a.txt"), "utf8")).toBe("a\n");
    await expect(fs.access(path.join(src, "a.txt"))).rejects.toThrow();

    const undone = await v.undoBatch("b1");
    expect(undone).toHaveLength(1);
    expect(await fs.readFile(path.join(src, "a.txt"), "utf8")).toBe("a\n");
    await expect(fs.access(path.join(root, "문서", "a.txt"))).rejects.toThrow();
  });

  it("도착점은 루트 밖이면 여전히 거부한다 — 밖으로 흘리는 이동은 없다", async () => {
    const v = await openVault(root);
    await fs.writeFile(path.join(root, "b.txt"), "b\n");
    await expect(v.move("b.txt", path.join(src, "b.txt"))).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
  });

  it("저장소(.wasnew) 안에서 꺼내 오는 것도 거부한다", async () => {
    const v = await openVault(root);
    await expect(v.move(path.join(root, ".wasnew", "journal.jsonl"), "x.txt")).rejects.toMatchObject({ code: "IN_STORE" });
  });
});
