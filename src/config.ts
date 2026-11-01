import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_CACHE_DIRS = [
  "~/.local/share/pnpm",
  "~/.cache/uv",
  "~/.local/share/uv",
  "~/.cargo",
];

/** Expand a leading ~ to the user's home directory, otherwise resolve. */
const expand = (dir: string): string =>
  dir === "~" ? homedir() : dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : resolve(dir);

export interface HostConfig {
  cacheDirs: string[];
}

/**
 * Load ~/.key/config.json. Missing file or omitted cacheDirs falls back to
 * DEFAULT_CACHE_DIRS; a supplied list replaces them. Paths may be absolute
 * or start with ~. Throws loudly on unreadable or malformed JSON, or on
 * non-array / non-string entries.
 */
export function loadHostConfig(path = join(homedir(), ".key", "config.json")): HostConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { cacheDirs: DEFAULT_CACHE_DIRS.map(expand) };
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`key: malformed config at ${path}: ${(err as Error).message}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`key: config at ${path} must be a JSON object`);
  }

  const { cacheDirs } = parsed as { cacheDirs?: unknown };
  if (cacheDirs === undefined) return { cacheDirs: DEFAULT_CACHE_DIRS.map(expand) };
  if (!Array.isArray(cacheDirs) || cacheDirs.some((d) => typeof d !== "string" || d === "")) {
    throw new Error(`key: cacheDirs in ${path} must be an array of non-empty strings`);
  }

  return { cacheDirs: (cacheDirs as string[]).map(expand) };
}
