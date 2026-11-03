// One conversation's bubblewrap sandbox: a read-only host, the worktree and the caches writable.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";

const home = homedir();
// Where pnpm keeps its store operation locks, and where the session sockets live.
const runtimeDirectory = join("/run/user", String(userInfo().uid));

// Writable package-manager caches and state.
const CACHES = [
  join(home, ".local/share/pnpm"),
  join(home, ".cache/pnpm"),
  join(home, ".local/state/pnpm"),
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
    // Not a git repository — or git unable to answer — means no bind to add.
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
    // Fresh locks for pnpm, and the host's session sockets masked: ro-bind blocks
    // writes, not connect().
    "--tmpfs",
    runtimeDirectory,
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
  const env = new RemoteExecutionEnv({
    connection,
    id: `bwrap:${conversationId}`,
    cwd,
  });
  return { connection, env };
}

/** One invocation's environment: the invocation that built it is the sandbox's whole lifetime, so its abort signal is the close. */
export function sandboxEnv(
  conversationId: ConversationId,
  cwd: string,
  daemon: string,
  context: Context,
  open: typeof openSandbox = openSandbox,
): ExecutionEnv {
  const sandbox = open(conversationId, cwd, daemon);
  const { abortSignal: signal } = context;
  if (signal === undefined) throw new Error("sandboxEnv: the context has no abort signal");
  signal.addEventListener("abort", () => sandbox.connection.close(), { once: true });
  return sandbox.env;
}
