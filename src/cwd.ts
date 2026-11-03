import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** A directory on the host: `~` is its home, and a relative path starts at the given directory. */
export function targetCwd(path: string, base = process.cwd()): string {
  const home = homedir();
  const expanded = path === "~" || path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
  const resolved = resolve(base, expanded);
  if (!statSync(resolved).isDirectory()) throw new Error(`not a directory: ${resolved}`);
  return resolved;
}
