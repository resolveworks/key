import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** A directory on the host: `~` is its home, and a relative path starts at the given directory. */
export function targetCwd(path: string, base: string | undefined): string {
  const home = homedir();
  const expanded = path === "~" || path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
  if (isAbsolute(expanded)) return directory(resolve(expanded));
  if (base === undefined) throw new Error(`no directory to resolve ${path} against`);
  return directory(resolve(base, expanded));
}

function directory(path: string): string {
  if (!statSync(path).isDirectory()) throw new Error(`not a directory: ${path}`);
  return path;
}
