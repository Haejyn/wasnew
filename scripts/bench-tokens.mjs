// How much of an agent's context a big result costs, before and after summaries. Builds one
// realistic task (5,000 files from inbox/ into sorted/<ext>/ and sorted/2026/<month>/, plus 300
// trashes), then measures the MCP result text the agent would read, next to `git status --porcelain`
// for the same changes. Tokens are approximated as characters / 4. Run `pnpm build` first.
//   node scripts/bench-tokens.mjs
import { undoResult } from "../dist/mcp.js";
import { summarizeOps } from "../dist/index.js";

const EXTS = ["jpg", "png", "pdf", "txt", "mp4"];
const NAMES = { jpg: (i) => `IMG_2026${pad(1 + (i % 12))}${pad(1 + (i % 28))}_${String(100000 + i * 37).slice(-6)}.jpg`, png: (i) => `Screenshot 2026-${pad(1 + (i % 12))}-${pad(1 + (i % 28))} at ${pad(i % 24)}.${pad(i % 60)}.png`, pdf: (i) => `invoice-${20000 + i}.pdf`, txt: (i) => `notes ${i}.txt`, mp4: (i) => `VID_${30000 + i}.mp4` };
function pad(n) { return String(n).padStart(2, "0"); }

// a fixed-seed generator so every run measures the same list
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const batch = "mcp-20261017-140211-3f2a";
const by = { agent: "claude-code 2.1.0", model: "claude-opus", reason: "sort inbox by type and month" };
const records = [];
for (let i = 0; i < 5000; i++) {
  const ext = EXTS[Math.floor(rand() * EXTS.length)];
  const name = NAMES[ext](i);
  // photos and videos go by month, the rest by type
  const to = ext === "jpg" || ext === "mp4" ? `sorted/2026/${pad(1 + Math.floor(rand() * 12))}/${name}` : `sorted/${ext}/${name}`;
  records.push({ from: `inbox/${name}`, to, at: new Date(Date.UTC(2026, 9, 17, 14, 2, 11, i)).toISOString(), batch, by });
}
for (let i = 0; i < 300; i++) {
  const name = `~tmp${i}.tmp`;
  records.push({ from: `inbox/${name}`, to: `trash/20261017-140215123-9c1e/inbox/${name}`, at: new Date(Date.UTC(2026, 9, 17, 14, 2, 15, i)).toISOString(), batch, trashed: true, by });
}
// undo returns newest first
const undo = { undone: [...records].reverse().map(({ from, to, at, batch, trashed, by }) => ({ from, to, at, batch, ...(trashed ? { trashed } : {}), by })), skipped: [] };
const moves = records.filter((r) => !r.trashed);

// the server sends JSON.stringify(result, null, 1) as the text content
const asText = (r) => JSON.stringify(r, null, 1);
const rows = [
  ["wasnew_undo, every item (before)", asText(undo)],
  ["wasnew_undo, summary + first 20 (after)", asText(undoResult(undo, false))],
  ["wasnew_move, 5,000 moves (before)", asText({ batch, moved: moves.length, failed: [] })],
  ["wasnew_move, 5,000 moves (after)", asText({ summary: summarizeOps(moves).lines, batch, moved: moves.length, failed: [] })],
  ["git status --porcelain, same changes", records.map((r) => (r.trashed ? `D  ${r.from}` : `R  ${r.from} -> ${r.to}`)).join("\n")],
];

console.log(`${records.length} operations: ${moves.length} moves, ${records.length - moves.length} trashes\n`);
const w = Math.max(...rows.map(([n]) => n.length));
console.log(`${"result".padEnd(w)}  ${"chars".padStart(9)}  ${"~tokens".padStart(8)}`);
for (const [name, text] of rows) console.log(`${name.padEnd(w)}  ${text.length.toLocaleString("en-US").padStart(9)}  ${Math.round(text.length / 4).toLocaleString("en-US").padStart(8)}`);
console.log("\n~tokens is characters / 4, an approximation; real tokenizers differ, more so for non-English names.");
console.log("\nsummary the agent reads after undo:\n" + undoResult(undo, false).summary.map((l) => "  " + l).join("\n"));
