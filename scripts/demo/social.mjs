#!/usr/bin/env node
// Renders assets/social-preview.png (1280x640) for GitHub's social preview setting:
// the icon, the name and the definition line from README.md on a plain background.
// usage: PLAYWRIGHT_DIR=<folder with playwright installed> node scripts/demo/social.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const readme = readFileSync(path.join(repo, "README.md"), "utf8");
const definition = readme.split("\n").find((l) => l.startsWith("wasnew is "));
if (!definition) throw new Error("definition line not found in README.md");
const icon = readFileSync(path.join(repo, "assets", "icon-512.png")).toString("base64");
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const html = `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1280px; height: 640px; background: #000; }
  body { display: flex; align-items: center; gap: 56px; padding: 0 96px; box-sizing: border-box;
         font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: #f2efe6; }
  img { width: 300px; height: 300px; border-radius: 40px; flex: none; }
  h1 { margin: 0 0 22px; font-size: 76px; font-weight: 600; letter-spacing: -1px; }
  p { margin: 0; font-size: 30px; line-height: 1.4; color: #c9c5ba; }
</style>
<img src="data:image/png;base64,${icon}" alt="">
<div><h1>wasnew</h1><p>${esc(definition.replace(/^wasnew is an?/, "An").replace(/^./, (c) => c.toUpperCase()))}</p></div>`;

const req = createRequire(process.env.PLAYWRIGHT_DIR ? path.join(path.resolve(process.env.PLAYWRIGHT_DIR), "x.js") : import.meta.url);
const { chromium } = req("playwright");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.screenshot({ path: path.join(repo, "assets", "social-preview.png") });
await browser.close();
console.log("assets/social-preview.png");
