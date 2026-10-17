#!/usr/bin/env node
// Builds a throwaway folder that looks like a messy Downloads folder, for recording the demo.
// usage: node scripts/demo/setup.mjs [dir]   (default: <tmp>/wasnew-demo/Downloads)
// It wipes [dir] first, fills it with ~180 files, and writes .mcp.json and .claude/settings.json
// so Claude Code started in [dir] gets the wasnew MCP server and the two example hooks.
// Run `pnpm build` before this so bin/wasnew.js works.
import { mkdirSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "wasnew-demo", "Downloads"));
if (!existsSync(path.join(repo, "dist", "index.js"))) {
  console.error("dist/ is missing: run `pnpm build` first");
  process.exit(1);
}
if (path.basename(path.dirname(dir)) !== "wasnew-demo" && !process.argv.includes("--force")) {
  console.error(`refusing to wipe ${dir}: its parent folder must be named wasnew-demo (or pass --force)`);
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// a seeded random so every run makes the same folder
let seed = 20261012;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pad = (n, w = 2) => String(n).padStart(w, "0");

// tiny but valid file headers
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f0d3e90000000049454e44ae426082", "hex");
const JPG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbd3ffd9", "hex");
const ZIP = Buffer.from("504b0506000000000000000000000000000000000000", "hex"); // empty zip, also what an empty docx/xlsx starts as
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(126)]);

// a one-page PDF with real text, so the agent can read the invoice total
function pdf(lines) {
  const text = lines.map((l, i) => `BT /F1 ${i === 0 ? 16 : 11} Tf 60 ${760 - i * 22} Td (${l.replace(/[()\\]/g, "\\$&")}) Tj ET`).join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${pad(o, 10)} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const genericPdf = (title) => pdf([title, "This document is a placeholder made for the wasnew demo."]);

const files = new Map();
const add = (name, data) => { if (!files.has(name)) files.set(name, data); };

// photos off a phone
let img = 2014;
for (let i = 0; i < 46; i++) add(`IMG_${img += int(1, 9)}.jpg`, JPG);
for (let i = 0; i < 8; i++) add(`IMG_${img += int(1, 9)}.HEIC`, JPG);
for (let i = 0; i < 6; i++) add(`PXL_202609${pad(int(1, 30))}_${pad(int(8, 21))}${pad(int(0, 59))}${pad(int(0, 59))}.jpg`, JPG);
// screenshots
for (let i = 0; i < 28; i++) add(`Screenshot 2026-${pad(int(8, 10))}-${pad(int(1, 28))} at ${pad(int(9, 23))}.${pad(int(0, 59))}.${pad(int(0, 59))}.png`, PNG);
for (let i = 0; i < 5; i++) add(`Screen Recording 2026-10-${pad(int(1, 16))} at ${pad(int(9, 22))}.${pad(int(0, 59))}.${pad(int(0, 59))}.mov`, Buffer.alloc(64));
// images from the web
for (const n of ["image.png", "image (1).png", "image (2).png", "logo-final.svg", "meme.gif", "wallpaper-4k.jpg", "diagram.png", "avatar.webp", "banner_v2.png", "receipt-photo.jpg"]) add(n, n.endsWith(".svg") ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>') : n.endsWith(".jpg") ? JPG : PNG);

// documents
add("invoice_oct.pdf", pdf([
  "INVOICE  #2026-1043",
  "Northwind Hosting Ltd.",
  "Billed to: Demo User",
  "Date: 2026-10-03     Due: 2026-10-17",
  "",
  "VPS plan (October)                      $48.00",
  "Extra storage 200 GB                    $14.00",
  "Backups                                 $9.50",
  "Domain renewal (wasnew-demo.dev)        $12.00",
  "",
  "Subtotal                                $83.50",
  "Tax (10%)                               $8.35",
  "Total due                               $91.85",
]));
for (const n of ["invoice_sep.pdf", "invoice_aug.pdf", "boarding-pass.pdf", "lease_agreement_signed.pdf", "bank-statement-2026-09.pdf", "W-9.pdf",
  "tax_return_2025.pdf", "insurance-card.pdf", "concert-tickets.pdf", "Q3_report.pdf", "paper_attention_is_all_you_need.pdf", "2310.06825v1.pdf",
  "syllabus_cs341.pdf", "manual_dishwasher.pdf", "warranty.pdf", "order-confirmation-88213.pdf", "visa_application.pdf", "menu.pdf"]) add(n, genericPdf(n.replace(/\.pdf$/, "")));
for (const n of ["resume_v3_final.docx", "resume_v3_final_FINAL.docx", "cover_letter.docx", "meeting-notes.docx", "draft.docx", "thesis_ch2.docx", "reference_letter.docx"]) add(n, ZIP);
for (const n of ["budget_2026.xlsx", "expenses.xlsx", "grades.csv", "contacts.csv", "export_2026-10-11.csv", "survey_results.xlsx"]) add(n, n.endsWith(".csv") ? Buffer.from("name,value\na,1\nb,2\n") : ZIP);
for (const n of ["pitch_deck.pptx", "lecture_07.pptx", "team-offsite.key"]) add(n, ZIP);
for (const n of ["notes.txt", "todo.txt", "README.md", "wifi password.txt", "recipe.txt"]) add(n, Buffer.from("text\n"));

// installers and archives
for (const n of ["setup-x64.exe", "ChromeSetup.exe", "VSCodeUserSetup-x64-1.104.0.exe", "node-v22.20.0-x64.msi", "Zoom_installer.exe", "python-3.13.7-amd64.exe",
  "Docker Desktop Installer.exe", "obs-studio-32.0.1-windows-x64.exe", "steam_installer.exe"]) add(n, EXE);
for (const n of ["Discord.dmg", "Figma-125.6.zip", "fonts.zip", "photos_export.zip", "project-backup-2026-09.zip", "dataset.tar.gz", "archive (1).zip", "drivers.7z", "slides_and_notes.zip"]) add(n, ZIP);
// audio and video
for (const n of ["podcast_ep42.mp3", "voice-memo-2026-10-02.m4a", "lecture-recording.mp4", "clip.mp4", "song.flac", "ringtone.m4r"]) add(n, Buffer.alloc(128));
// code and misc
for (const n of ["script.py", "index.html", "styles.css", "config.json", "data.json", "id_card_scan.tiff", "calendar.ics", "contact.vcf", "torrent_file.torrent", "font.ttf"]) add(n, Buffer.from("x\n"));

// junk: temp files, partial downloads, office lock files
for (let i = 0; i < 9; i++) add(`download (${i + 1}).tmp`, Buffer.alloc(16));
for (const n of ["~$draft.docx", "~$budget_2026.xlsx", "~$sume_v3_final.docx", "~$tch_deck.pptx"]) add(n, Buffer.alloc(162));
for (const n of ["ubuntu-24.04.3-desktop-amd64.iso.crdownload", "Unconfirmed 381245.crdownload", "big_dataset.zip.crdownload", "movie.mkv.part", "installer.exe.part", "video.mp4.download"]) add(n, Buffer.alloc(32));
for (const n of ["tmp1a2b3c.tmp", "~WRL0003.tmp", "chrome_drag12345_678.tmp"]) add(n, Buffer.alloc(8));

const now = Date.now();
for (const [name, data] of files) {
  const p = path.join(dir, name);
  writeFileSync(p, data);
  const t = new Date(now - int(1, 120) * 86400e3 - int(0, 86400) * 1e3);
  utimesSync(p, t, t);
}

// Claude Code config: the wasnew MCP server for this folder, and the two example hooks
const node = (p) => `node "${p.replaceAll("\\", "/")}"`;
writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({
  mcpServers: { wasnew: { command: "node", args: [path.join(repo, "bin", "wasnew.js").replaceAll("\\", "/"), "mcp", "--root", dir.replaceAll("\\", "/")] } },
}, null, 2) + "\n");
mkdirSync(path.join(dir, ".claude"), { recursive: true });
writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify({
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: node(path.join(repo, "examples", "claude-code", "guard.mjs")) }] },
      { matcher: "Read|Edit|MultiEdit", hooks: [{ type: "command", command: node(path.join(repo, "examples", "claude-code", "moved.mjs")) }] },
    ],
  },
}, null, 2) + "\n");

console.log(`${files.size} files in ${dir}`);
