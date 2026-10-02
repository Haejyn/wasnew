/**
 * gitignore-style rules for `.wasnewignore`.
 * Rules apply in order; once a parent directory is ignored a child `!rule` cannot bring it back (same as git).
 */
interface Rule { negated: boolean; directoryOnly: boolean; re: RegExp }

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      out += escapeRegex(pattern[++i]);
    } else if (c === "*") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i++;
        if (pattern[i + 1] === "/") { i++; out += "(?:.*/)?"; }
        else out += ".*";
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) { out += "\\["; continue; }
      let cls = pattern.slice(i + 1, end);
      if (cls.startsWith("!")) cls = "^" + cls.slice(1);
      out += "[" + cls + "]";
      i = end;
    } else {
      out += escapeRegex(c);
    }
  }
  return out;
}

export function parseIgnore(rules: string): Rule[] {
  return rules.split(/\r?\n/).flatMap((raw) => {
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (!line || line[0] === "#") return [];
    const negated = line[0] === "!";
    if (negated) line = line.slice(1);
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);
    const rooted = line.startsWith("/") || line.includes("/");
    line = line.replace(/^\//, "");
    return [{ negated, directoryOnly, re: new RegExp((rooted ? "^" : "(?:^|/)") + globToRegex(line) + "$") }];
  });
}

export function ignoredBy(rules: Rule[], relPath: string, isDirectory = false): boolean {
  const parts = relPath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "").split("/");
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join("/");
    const dir = i < parts.length || isDirectory;
    let ignored = false;
    for (const rule of rules) {
      if ((!rule.directoryOnly || dir) && rule.re.test(candidate)) ignored = !rule.negated;
    }
    if (ignored) return true;
  }
  return false;
}

/** One-shot form; parse once with `parseIgnore` when checking many paths. */
export function wasnewIgnored(relPath: string, rules: string, isDirectory = false): boolean {
  return ignoredBy(parseIgnore(rules), relPath, isDirectory);
}
