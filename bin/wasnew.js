#!/usr/bin/env node
// Committed shim so package managers can link the bin before dist/ is built.
import("../dist/cli.js").catch((e) => {
  if (e?.code === "ERR_MODULE_NOT_FOUND") console.error("wasnew is not built yet — run `pnpm build` in the wasnew package");
  else console.error(e);
  process.exitCode = 1;
});
