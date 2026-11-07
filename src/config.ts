// Key's own directories: config holds credentials and the sandbox manifest; sessions hold the
// database and worker checkouts. `KEY_CONFIG_DIR` and `KEY_SESSION_DIR` move them; both default
// to `~/.key`, and sessions follow a moved config directory unless named themselves.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_PORT = 7317;

/** `~` at the front is the user's home, as in a sandbox manifest. */
function expand(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function directory(name: string, fallback: string): string {
  return resolve(expand(process.env[name] || fallback, homedir()));
}

/** The config directory: credentials and the sandbox manifest. */
export function configDir(): string {
  return directory("KEY_CONFIG_DIR", join(homedir(), ".key"));
}

/** The session directory: the session database and worker checkouts. */
export function sessionDir(): string {
  return directory("KEY_SESSION_DIR", configDir());
}

export function authFile(): string {
  return join(configDir(), "auth.json");
}

export function sandboxFile(): string {
  return join(configDir(), "sandbox.json");
}

export function sessionFile(): string {
  return join(sessionDir(), "session.sqlite");
}

export function worktreesDir(): string {
  return join(sessionDir(), "worktrees");
}

/** The port `key serve` binds; the client agrees unless `KEY_HOST` names another. */
export function port(): number {
  return Number(process.env.KEY_PORT || DEFAULT_PORT);
}
