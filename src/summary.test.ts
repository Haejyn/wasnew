import { describe, it, expect } from "vitest";
import { summarizeOps, type SummaryOp } from "./summary.js";

const EXTS = ["jpg", "png", "pdf", "txt", "mp4"];

describe("summarizeOps", () => {
  it("groups by folders and extension, biggest first", () => {
    const ops: SummaryOp[] = [];
    for (let i = 0; i < 751; i++) ops.push({ from: `Downloads/p${i}.jpg`, to: `sorted/jpg/p${i}.jpg` });
    for (let i = 0; i < 120; i++) ops.push({ op: "trash", from: `Downloads/t${i}.tmp` });
    ops.push({ from: "Downloads/report.pdf", to: "Docs/report.pdf" });
    const s = summarizeOps(ops);
    expect(s.lines).toEqual(["751 × *.jpg  Downloads/ → sorted/jpg/", "120 × *.tmp  Downloads/ → trash", "1 × report.pdf  Downloads/ → Docs/"]);
    expect(s.total).toBe(872);
    expect(s.groups[0]).toEqual({ count: 751, pattern: "*.jpg  Downloads/ → sorted/jpg/" });
  });

  it("shows a rename pattern when the names share one", () => {
    const ops = Array.from({ length: 40 }, (_, i) => ({ from: `Photos/IMG_${1000 + i}.jpg`, to: `Photos/2026-${100 + i}.jpg` }));
    expect(summarizeOps(ops).lines).toEqual(["40 renamed in Photos/ (IMG_*.jpg → 2026-*.jpg)"]);
    const plain = [{ from: "Photos/a.jpg", to: "Photos/x.jpg" }, { from: "Photos/b.jpg", to: "Photos/y.jpg" }];
    expect(summarizeOps(plain).lines).toEqual(["2 renamed in Photos/"]);
  });

  it("merges into wider patterns past maxLines and says how many groups are left", () => {
    const ops: SummaryOp[] = [];
    for (let i = 0; i < 5000; i++) {
      const ext = EXTS[i % 5];
      ops.push({ from: `inbox/f${i}.${ext}`, to: i % 3 ? `sorted/${ext}/f${i}.${ext}` : `sorted/2026/${String((Math.floor(i / 3) % 12) + 1).padStart(2, "0")}/f${i}.${ext}` });
    }
    const s = summarizeOps(ops);
    expect(s.lines.length).toBeLessThanOrEqual(12);
    expect(s.lines[0]).toBe("1,667 × *  inbox/ → sorted/2026/*/");
    expect(s.lines).toContain("667 × *.png  inbox/ → sorted/png/");
    expect(summarizeOps(ops, { maxLines: 3 }).lines).toEqual(["5,000 × *  inbox/ → sorted/*/"]);
    const many = Array.from({ length: 30 }, (_, i) => ({ op: "trash" as const, from: `d${i}/x.tmp` }));
    const cut = summarizeOps(many, { maxLines: 5 });
    expect(cut.lines).toHaveLength(5);
    expect(cut.lines[4]).toBe("… 26 more groups");
    expect(cut.groups).toHaveLength(30);
  });

  it("is deterministic whatever the input order", () => {
    const ops = [{ from: "b/1.txt", to: "c/1.txt" }, { from: "a/1.txt", to: "c/1.txt" }, { op: "trash" as const, from: "z.log" }];
    expect(summarizeOps(ops).lines).toEqual(summarizeOps([...ops].reverse()).lines);
    expect(summarizeOps(ops).lines).toEqual(["1 × 1.txt  a/ → c/", "1 × 1.txt  b/ → c/", "1 × z.log  ./ → trash"]);
  });

  it("marks undone moves and trash coming back", () => {
    const s = summarizeOps([
      { op: "undo", from: "sorted/jpg/a.jpg", to: "inbox/a.jpg" },
      { op: "undo", from: "sorted/jpg/b.jpg", to: "inbox/b.jpg" },
      { op: "undo", from: "trash/20261017-1/inbox/c.tmp", to: "inbox/c.tmp", trashed: true },
    ]);
    expect(s.lines).toEqual(["2 × *.jpg  sorted/jpg/ → inbox/ (undone)", "1 × c.tmp  trash → inbox/ (undone)"]);
  });
});
