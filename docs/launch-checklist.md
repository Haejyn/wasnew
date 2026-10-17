# Launch checklist

Things that happen outside the repo. Check them off in order.

## GitHub repo settings

- [ ] Description (About):
  `Undo layer for AI agents' file operations. Journals every move, rename and delete an agent makes in any folder and undoes them per task, with or without git. MCP server, CLI, library.`
- [ ] Website: `https://github.com/Haejyn/wasnew#readme` (or the npm page after publishing)
- [ ] Topics (20, GitHub's limit):
  `ai-agent` `undo` `mcp` `mcp-server` `model-context-protocol` `claude-code` `claude` `rollback` `checkpoint` `trash` `safe-delete` `file-operations` `journal` `snapshot` `agent-safety` `ai-safety` `llm` `cli` `nodejs` `typescript`
- [ ] Social preview image (Settings → General): icon on a plain background with the one-line definition
- [ ] Merge `docs/launch` into `main` so the llms.txt and README links (which point at `main`) resolve
- [ ] Check that CITATION.cff shows the "Cite this repository" button

## npm publish

- [ ] Confirm the name `wasnew` is free: `npm view wasnew`
- [ ] Remove `"private": true` from package.json
- [ ] Bump the version if needed and update `version` in CITATION.cff to match
- [ ] `pnpm install && pnpm typecheck && pnpm test`
- [ ] `npm pack --dry-run`: expect bin, dist, README.md, README.ko.md, LICENSE, NOTICE, CITATION.cff, llms.txt, assets, examples and no src or tests (`prepack` runs the build)
- [ ] Try the tarball in an empty folder: `npm i ../wasnew-x.y.z.tgz`, then `npx wasnew --version` and `node -e "import('wasnew')"`
- [ ] `npm login`, then `npm publish` (add `--provenance` if publishing from GitHub Actions)
- [ ] Update README and README.ko.md quick start: `claude mcp add --transport stdio wasnew -- npx -y wasnew mcp --root ~/Downloads`
- [ ] Tag the release (`git tag v0.3.0 && git push --tags`) and write GitHub release notes

## Demo GIF (about 30 seconds)

- [ ] Scene 1: a Downloads folder with ~200 mixed files. Ask Claude Code "sort my downloads, trash the .tmp junk"
- [ ] Scene 2: the agent calls `wasnew_snapshot`, `wasnew_move` and `wasnew_trash` (no bash). Show the summary lines, e.g. `151 × *.jpg  ./ → Pictures/2026/`
- [ ] Scene 3: the agent tries `rm` once and the guard hook blocks it with "Use wasnew_trash (undoable) instead"
- [ ] Scene 4: the agent then tries to `Read` a file at its old path; the moved-file hook stops it and gives the new path
- [ ] Scene 5: in a terminal, `wasnew undo --batch <batch>` prints `undone 226`, and the folder is back as it was
- [ ] Record at a readable font size, crop to the terminal, keep it under 5 MB, save as `assets/demo.gif`, add it under the definition line in both READMEs

## Where to post

- [ ] Show HN, title: `Show HN: Wasnew, undo for files an AI agent moved or deleted`
  First comment: the Claude Code docs quote on bash changes, the benchmark table, and the row wasnew loses
- [ ] r/ClaudeAI (and r/ClaudeCode): GIF first, then the quick start
- [ ] Official MCP Registry (registry.modelcontextprotocol.io): needs the npm package first; follow its publisher CLI steps (`server.json`, `mcpName` in package.json)
- [ ] glama.ai MCP server directory: submit the GitHub URL
- [ ] mcpmarket.com: submit the GitHub URL
- [ ] awesome-mcp-servers lists: open a PR under the file system or developer tools category
- [ ] After a week: check what Perplexity, ChatGPT search and Google AI Overviews say for "undo rm claude code" and "undo files ai agent deleted"; adjust the README FAQ wording if they quote it wrong
