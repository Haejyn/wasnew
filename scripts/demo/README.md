# Demo recording

`assets/demo.gif` and `assets/demo.mp4` replay a real Claude Code session. Claude Code ran headless (`claude -p --output-format stream-json --verbose`) in a throwaway folder, and the replay is drawn from that log. The take used is in [`take/`](take/).

## Steps

```bash
pnpm build
node scripts/demo/setup.mjs                      # <tmp>/wasnew-demo/Downloads with 199 files, .mcp.json and the two hooks
node scripts/demo/run.mjs <demo dir> <raw dir>   # three prompts, then wasnew pending and wasnew undo
node scripts/demo/scrub.mjs <raw dir>            # copies the take into take/ without paths, user name or session ids
node scripts/demo/render.mjs                     # assets/demo.mp4, demo.gif, demo-poster.png
node scripts/demo/social.mjs                     # assets/social-preview.png
```

`render.mjs` and `social.mjs` need ffmpeg on PATH and playwright with chromium. Playwright is not a dependency of wasnew; install it in any folder (`npm i playwright && npx playwright install chromium`) and set `PLAYWRIGHT_DIR` to that folder.

## The session

The prompts are in [`prompts.json`](prompts.json):

1. "sort my downloads into folders and get rid of the junk (.tmp, partial downloads, office lock files)"
2. "open invoice_oct.pdf and tell me the total", in a new session, so the agent does not know where the file went and asks for the old path
3. "i dont need the screenshots anymore, just run rm -rf Screenshots", continuing session 2

`run.mjs` allows the wasnew MCP tools, Read, Bash, Glob and Grep with `--permission-mode dontAsk`, and turns off the PowerShell tool so shell commands go through Bash, where the example guard hook is attached. It loads only the demo folder's own settings (`--setting-sources project`).

## What the replay changes

Tool calls are shown as one line each with a short result: wasnew results as a few of their JSON fields, Bash commands without their leading `cd "<folder>" &&`, and long lines cut with "…". Only the prose paragraphs of the agent's answers are shown; tables and lists are cut, and a line says how many lines were left out. ToolSearch calls (Claude Code loading tool schemas) are not shown. The waits between events are set to a fixed pace; the real time of each session is shown at its end. Prompt 3 was run with `--resume <session id>` and is shown as `claude -p -c`. Everything else on screen is what the log recorded.
