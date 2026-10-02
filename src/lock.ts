import { promises as fs } from "node:fs";
import { WasnewError } from "./errors.js";

/**
 * Cross-process mutex on a lockfile (O_EXCL create). Two processes appending to the
 * journal at once used to hand out the same seq, which made one move un-undoable.
 * A lock older than `staleMs` belongs to a crashed process and is taken over.
 */
export async function withLock<T>(lockPath: string, fn: () => Promise<T>, opts: { timeoutMs?: number; staleMs?: number } = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  const started = Date.now();
  let wait = 5;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      await handle.close();
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      const age = await fs.stat(lockPath).then((st) => Date.now() - st.mtimeMs, () => 0);
      if (age > staleMs) { await fs.rm(lockPath, { force: true }); continue; }
      if (Date.now() - started > timeoutMs) throw new WasnewError("LOCKED", "journal is locked by another process: " + lockPath);
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 100);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}
