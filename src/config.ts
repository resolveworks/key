// Key's directories: config holds credentials and the sandbox manifest; data holds the session
// database and worker checkouts. Both follow the XDG base directory spec, so `XDG_CONFIG_HOME`
// and `XDG_DATA_HOME` move them.

import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PORT = 7317;

/** An XDG base directory: the variable when set, else its home-relative default. */
function base(variable: "XDG_CONFIG_HOME" | "XDG_DATA_HOME", fallback: string): string {
  return process.env[variable] || join(homedir(), fallback);
}

/** The config directory: credentials and the sandbox manifest. */
export function configDir(): string {
  return join(base("XDG_CONFIG_HOME", ".config"), "key");
}

/** The data directory: the session database and worker checkouts. */
export function dataDir(): string {
  return join(base("XDG_DATA_HOME", join(".local", "share")), "key");
}

export function authFile(): string {
  return join(configDir(), "auth.json");
}

export function sandboxFile(): string {
  return join(configDir(), "sandbox.json");
}

export function sessionFile(): string {
  return join(dataDir(), "session.sqlite");
}

export function worktreesDir(): string {
  return join(dataDir(), "worktrees");
}

/** The port `key serve` binds; the client agrees unless `KEY_HOST` names another. */
export function port(): number {
  return Number(process.env.KEY_PORT || DEFAULT_PORT);
}
