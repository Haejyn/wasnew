// Measures the README numbers on a throwaway folder: snapshot (with a 1 GiB file), 2,625 moves, undo, re-snapshot. Run `pnpm build` first.
import { openVault } from "../dist/index.js";
import { promises as fs } from "node:fs"; import path from "node:path"; import os from "node:os";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "wasnew-bench-"));
const N = 2625;
for (let i = 0; i < N; i++) await fs.writeFile(path.join(root, `file-${i}.txt`), `content ${i % 500}\n`);
const big = path.join(root, "big.bin"); const fh = await fs.open(big, "w"); const chunk = Buffer.alloc(64 * 1024 ** 2, 7); for (let i = 0; i < 16; i++) await fh.write(chunk); await fh.close(); // 1 GiB
const v = await openVault(root);
const t = () => performance.now(); let a;
const rss0 = process.memoryUsage().rss;
a = t(); const s = await v.snapshot(); const snapMs = t() - a; const rssPeak = process.memoryUsage().rss;
a = t(); for (let i = 0; i < N; i++) await v.move(`file-${i}.txt`, `sorted/${i % 26}/file-${i}.txt`, "b"); const moveMs = t() - a;
a = t(); const u = await v.undo({ batch: "b" }); const undoMs = t() - a;
a = t(); const s2 = await v.snapshot(); const snap2Ms = t() - a;
console.log(JSON.stringify({ files: s.fileCount, newBlobs: s.newBlobs, snapMs: Math.round(snapMs), rssMB: Math.round((rssPeak) / 1024 ** 2), moves: N, moveMs: Math.round(moveMs), undone: u.undone.length, undoMs: Math.round(undoMs), resnapMs: Math.round(snap2Ms), resnapNewBlobs: s2.newBlobs, resnapHashed: s2.hashed }));
await fs.rm(root, { recursive: true, force: true });
