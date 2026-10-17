# Launch checklist

Things that happen outside the repo. Check them off in order.

## GitHub repo settings

- [x] Description (About):
  `Undo layer for AI agents' file operations. Journals every move, rename and delete an agent makes in any folder and undoes them per task, with or without git. MCP server, CLI, library.`
- [x] Website: `https://github.com/Haejyn/wasnew#readme` (or the npm page after publishing)
- [x] Topics (20, GitHub's limit):
  `ai-agent` `undo` `mcp` `mcp-server` `model-context-protocol` `claude-code` `claude` `rollback` `checkpoint` `trash` `safe-delete` `file-operations` `journal` `snapshot` `agent-safety` `ai-safety` `llm` `cli` `nodejs` `typescript`
- [ ] Social preview image: upload `assets/social-preview.png` in Settings → General (made by `scripts/demo/social.mjs`)
- [x] Merge `docs/launch` into `main` so the llms.txt and README links (which point at `main`) resolve
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

## Demo GIF

- [x] `assets/demo.gif` (39 s, 2.6 MB), `assets/demo.mp4` and `assets/demo-poster.png`, under the definition line in both READMEs
  Made from a real headless Claude Code session: the agent sorts a 199-file Downloads folder with `wasnew_plan` and `wasnew_apply`, the moved-file hook redirects a `Read` of `invoice_oct.pdf` at its old path, the guard hook blocks `rm -rf Screenshots` and the agent uses `wasnew_trash`, then `wasnew undo` brings back all 199 files. Steps to record it again are in `scripts/demo/README.md`

## Where to post

- [ ] Show HN, title: `Show HN: Wasnew, undo for files an AI agent moved or deleted`
  First comment: the Claude Code docs quote on bash changes, the benchmark table, and the row wasnew loses
- [ ] r/ClaudeAI (and r/ClaudeCode): GIF first, then the quick start
- [ ] Official MCP Registry (registry.modelcontextprotocol.io), after `npm publish`. `server.json` and `mcpName` in package.json are ready (`io.github.Haejyn/wasnew`); bump the version in both when package.json changes
  1. Install the publisher CLI: `brew install mcp-publisher`, or on Windows (PowerShell):
     `$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }; Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"; tar xf mcp-publisher.tar.gz mcp-publisher.exe; rm mcp-publisher.tar.gz`
     then move `mcp-publisher.exe` to a folder on PATH and check with `mcp-publisher --help`
  2. `mcp-publisher login github` (sign in as `Haejyn`; the name prefix is case sensitive)
  3. `mcp-publisher publish` from the repo root
  4. Check: `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Haejyn/wasnew"`
- [ ] glama.ai MCP server directory: submit the GitHub URL
- [ ] mcpmarket.com: submit the GitHub URL
- [ ] awesome-mcp-servers lists: open a PR under the file system or developer tools category
- [ ] After a week: check what Perplexity, ChatGPT search and Google AI Overviews say for "undo rm claude code" and "undo files ai agent deleted"; adjust the README FAQ wording if they quote it wrong
