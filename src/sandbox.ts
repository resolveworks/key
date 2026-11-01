// One conversation's bubblewrap sandbox: a read-only host, the worktree and the caches writable.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";

const home = homedir();

const CACHES = [
  join(home, ".local/share/pnpm"),
  join(home, ".cache/uv"),
  join(home, ".local/share/uv"),
  join(home, ".cargo"),
] as const;

export type Sandbox = { readonly connection: Connection; readonly env: RemoteExecutionEnv };

/** The main repository's `.git` when `cwd` is a linked worktree outside it. */
function gitCommonDir(cwd: string): string | undefined {
  let stdout: string;
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  try {
    stdout = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
  if (stdout === "") return undefined;
  const path = resolve(cwd, stdout);
  const inside = relative(cwd, path);
  return inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
    ? undefined
    : path;
}

/** The bwrap argv that starts the sandbox, before `Connection` appends `serve --token`. */
export function sandboxCommand(cwd: string, daemon: string): string[] {
  for (const path of CACHES) mkdirSync(path, { recursive: true });
  const gitDir = gitCommonDir(cwd);
  return [
    "bwrap",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--bind",
    cwd,
    cwd,
    ...(gitDir === undefined ? [] : ["--bind", gitDir, gitDir]),
    ...CACHES.flatMap((path) => ["--bind", path, path]),
    "--die-with-parent",
    "--chdir",
    cwd,
    "--",
    daemon,
  ];
}

/** Open one conversation's sandbox: its connection starts lazily and restarts after loss. */
export function openSandbox(conversationId: ConversationId, cwd: string, daemon: string): Sandbox {
  const connection = new Connection({ command: sandboxCommand(cwd, daemon) });
  const env = new RemoteExecutionEnv({ connection, id: `bwrap:${conversationId}`, cwd });
  return { connection, env };
}
