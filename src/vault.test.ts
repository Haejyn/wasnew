import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openVault } from "./index.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "wasnew-"));
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "a.txt"), "hello\n");
  await fs.writeFile(path.join(root, "docs", "b.md"), "# b\n");
});

describe("snapshot / restore", () => {
  it("스냅샷 → 수정 → 복원하면 내용이 돌아온다", async () => {
    const v = await openVault(root);
    const s = await v.snapshot({ label: "before" });
    expect(s.fileCount).toBe(2);
    expect(s.newBlobs).toBe(2);

    await fs.writeFile(path.join(root, "a.txt"), "changed\n");
    const r = await v.restore(s.id);
    expect(r.restored).toBe(1);
    expect(r.skipped).toBe(1);
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("hello\n");
  });

  it("복원은 스냅샷에 없는 새 파일을 지우지 않는다 (삭제 금지)", async () => {
    const v = await openVault(root);
    const s = await v.snapshot();
    await fs.writeFile(path.join(root, "new.txt"), "keep me\n");
    await v.restore(s.id);
    expect(await fs.readFile(path.join(root, "new.txt"), "utf8")).toBe("keep me\n");
  });

  it("같은 내용은 blob 을 다시 만들지 않는다 (내용주소)", async () => {
    const v = await openVault(root);
    await v.snapshot();
    const s2 = await v.snapshot();
    expect(s2.newBlobs).toBe(0);
  });

  it("log 는 최신 먼저, .wasnew 자신은 스냅샷에 안 들어간다", async () => {
    const v = await openVault(root);
    const s1 = await v.snapshot({ label: "first" });
    const s2 = await v.snapshot({ label: "second" });
    const log = await v.log();
    expect(log).toHaveLength(2);
    expect(new Set(log.map((m) => m.id))).toEqual(new Set([s1.id, s2.id]));
    expect(log[0].created >= log[1].created).toBe(true); // 최신 먼저
    const full = await v.get(s1.id);
    expect(full.files.every((f) => !f.path.startsWith(".wasnew"))).toBe(true);
  });
});

describe("move / undo 저널", () => {
  it("move 하고 undoMoves 하면 제자리로", async () => {
    const v = await openVault(root);
    await v.move("a.txt", "docs/a.txt");
    expect(await fs.readFile(path.join(root, "docs", "a.txt"), "utf8")).toBe("hello\n");

    const undone = await v.undoMoves(1);
    expect(undone).toHaveLength(1);
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("hello\n");
    expect(await v.pendingMoves()).toHaveLength(0);
  });

  it("대소문자만 다른 이름으로 바꾸기 — Windows 에서는 '이미 있음' 으로 보이지만 같은 파일이다", async () => {
    await fs.writeFile(path.join(root, "Report.PDF"), "pdf");
    const v = await openVault(root);
    await v.move("Report.PDF", "Report.pdf");
    const names = await fs.readdir(root);
    expect(names).toContain("Report.pdf");
    expect(names.filter((n) => n.toLowerCase() === "report.pdf")).toHaveLength(1);
    await v.undoMoves(1);
    expect(await fs.readdir(root)).toContain("Report.PDF");
  });

  it("undo 후 이동이 만들었던 빈 폴더는 치워진다", async () => {
    const v = await openVault(root);
    await v.move("a.txt", "sorted/img/a.txt");
    await v.undoMoves(1);
    await expect(fs.access(path.join(root, "sorted"))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("hello\n");
  });

  it("목적지에 파일이 있으면 move 를 거부한다 (덮어쓰기 금지)", async () => {
    const v = await openVault(root);
    await expect(v.move("a.txt", "docs/b.md")).rejects.toMatchObject({ code: "DEST_EXISTS" });
  });

  it("원래 자리에 새 파일이 생겼으면 undo 는 덮지 않고 건너뛴다", async () => {
    const v = await openVault(root);
    await v.move("a.txt", "docs/a.txt");
    await fs.writeFile(path.join(root, "a.txt"), "usurper\n");
    const undone = await v.undoMoves(1);
    expect(undone).toHaveLength(0);
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("usurper\n");
    expect(await v.pendingMoves()).toHaveLength(1); // 여전히 되돌릴 수 있는 것으로 남는다
  });

  it("묶음(batch)으로 되돌리면 그 사이에 낀 다른 이동은 그대로 둔다", async () => {
    const v = await openVault(root);
    await v.move("a.txt", "docs/a.txt", "batch-1");
    await fs.writeFile(path.join(root, "c.txt"), "c\n");
    await v.move("c.txt", "docs/c.txt");                 // 묶음 밖 이동
    const undone = await v.undoBatch("batch-1");
    expect(undone).toHaveLength(1);
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("hello\n");
    expect(await fs.readFile(path.join(root, "docs", "c.txt"), "utf8")).toBe("c\n");  // 남아 있다
  });

  it("한 묶음의 이동 여럿을 한 번에 되돌린다", async () => {
    const v = await openVault(root);
    await fs.writeFile(path.join(root, "c.txt"), "c\n");
    await v.move("a.txt", "sorted/a.txt", "b1");
    await v.move("c.txt", "sorted/c.txt", "b1");
    expect(await v.undoBatch("b1")).toHaveLength(2);
    expect(await v.pendingMoves()).toHaveLength(0);
  });

  it("한 묶음의 마지막 N 개만 되돌린다 — 잘못 간 하나 때문에 전부를 되돌리지 않게", async () => {
    const v = await openVault(root);
    await fs.writeFile(path.join(root, "c.txt"), "c\n");
    await fs.writeFile(path.join(root, "d.txt"), "d\n");
    await v.move("a.txt", "sorted/a.txt", "b1");
    await v.move("c.txt", "sorted/c.txt", "b2");        // 사이에 낀 다른 묶음
    await v.move("d.txt", "sorted/d.txt", "b1");
    const undone = await v.undoLast("b1", 1);
    expect(undone.map((m) => m.from)).toEqual(["d.txt"]);          // b1 의 마지막 것만
    expect(await fs.readFile(path.join(root, "d.txt"), "utf8")).toBe("d\n");
    expect(await fs.readFile(path.join(root, "sorted", "a.txt"), "utf8")).toBe("hello\n");   // b1 의 앞 것은 그대로
    expect(await fs.readFile(path.join(root, "sorted", "c.txt"), "utf8")).toBe("c\n");       // 다른 묶음도 그대로
    expect((await v.pendingMoves()).filter((m) => m.batch === "b1")).toHaveLength(1);
  });

  it("모르는 묶음은 아무것도 안 되돌린다", async () => {
    const v = await openVault(root);
    await v.move("a.txt", "docs/a.txt", "b1");
    expect(await v.undoBatch("없는묶음")).toHaveLength(0);
    expect(await v.pendingMoves()).toHaveLength(1);
  });

  it("루트 밖·.wasnew 안은 거부", async () => {
    const v = await openVault(root);
    await expect(v.move("a.txt", "../escape.txt")).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
    await expect(v.move("a.txt", ".wasnew/objects/x")).rejects.toMatchObject({ code: "IN_STORE" });
  });
});

/**
 * 볼륨이 다르면 rename 이 EXDEV 로 튕긴다. 진짜 드라이브 두 개 없이 재현하려고
 * `fs.rename` 을 한 번만 EXDEV 로 던지게 바꿔 끼운다.
 */
describe("볼륨을 넘는 이동 (EXDEV 폴백)", () => {
  const exdev = () => Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });

  it("복사 → 대조 → 원본 삭제로 옮긴다", async () => {
    const v = await openVault(root);
    const real = fs.rename;
    let thrown = false;
    (fs as any).rename = async (a: string, b: string) => {
      if (!thrown) { thrown = true; throw exdev(); }     // 첫 시도만 튕긴다 (임시 → 진짜 이름은 통과)
      return real(a, b);
    };
    try {
      await v.move("a.txt", "docs/a.txt");
    } finally { (fs as any).rename = real; }
    expect(await fs.readFile(path.join(root, "docs", "a.txt"), "utf8")).toBe("hello\n");
    await expect(fs.access(path.join(root, "a.txt"))).rejects.toThrow();   // 원본은 지워졌다
    expect(await v.pendingMoves()).toHaveLength(1);                        // 저널에도 남는다
  });

  it("대조가 실패하면 원본을 지우지 않는다 — 크기가 같아도 해시로 잡는다", async () => {
    const v = await openVault(root);
    const realRename = fs.rename, realCopy = fs.copyFile;
    (fs as any).rename = async () => { throw exdev(); };
    (fs as any).copyFile = async (_from: string, to: string) => fs.writeFile(to, "howdy\n");   // 크기는 같고(6바이트) 내용만 다르다 — 해시가 잡아야 한다
    try {
      await expect(v.move("a.txt", "docs/a.txt")).rejects.toMatchObject({ code: "COPY_MISMATCH" });
    } finally { (fs as any).rename = realRename; (fs as any).copyFile = realCopy; }
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("hello\n");   // 살아 있다
    const left = await fs.readdir(path.join(root, "docs"));
    expect(left.filter((n) => n.includes("wasnew-tmp"))).toHaveLength(0);            // 임시본도 치웠다
    expect(await v.pendingMoves()).toHaveLength(0);                                 // 저널에 안 남는다
  });

  it("폴더는 볼륨을 넘길 수 없다고 분명히 말한다", async () => {
    const v = await openVault(root);
    const real = fs.rename;
    (fs as any).rename = async () => { throw exdev(); };
    try {
      await expect(v.move("docs", "sorted/docs")).rejects.toMatchObject({ code: "CROSS_DEVICE_DIR" });
    } finally { (fs as any).rename = real; }
    expect(await fs.readFile(path.join(root, "docs", "b.md"), "utf8")).toBe("# b\n");
  });
});
