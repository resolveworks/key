// One conversation's bubblewrap sandbox: a private home, the mounts the host declares, and only its environment.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { arr, bool, compile, map, obj, opt, type Static, str } from "@earendil-works/pi-schema";

const home = homedir();
// Where pnpm keeps its store operation locks, and where the session sockets live.
const runtimeDirectory = join("/run/user", String(userInfo().uid));

const manifestSchema = obj({
  mount: arr(
    obj({
      path: str({ minLength: 1 }),
      readonly: opt(bool()),
    }),
  ),
  env: map(str()),
});

export type SandboxManifest = Static<typeof manifestSchema>;

const manifest = compile(manifestSchema);

/** Replace `~` with the host home throughout a parsed manifest. */
function expand(value: unknown): unknown {
  if (typeof value === "string") return value.replaceAll("~", home);
  if (Array.isArray(value)) return value.map(expand);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, expand(item)]));
  return value;
}

/** Read, expand and validate `~/.key/sandbox.json`; a missing file, unknown key or wrong type throws. */
export function loadSandboxManifest(file = join(home, ".key", "sandbox.json")): SandboxManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${file}: ${error.message}`);
    throw error;
  }
  const value = expand(parsed);
  if (!manifest.check(value)) {
    const [first] = manifest.errors(value);
    throw new Error(`${file}: ${first?.path ?? "/"}: ${first?.message ?? "invalid"}`);
  }
  return value;
}

export type Sandbox = { readonly connection: Connection; readonly env: RemoteExecutionEnv };

/** The main repository's `.git`, which a linked worktree's commits write through the read-only host. */
function gitCommonDir(cwd: string): string | undefined {
  try {
    return (
      execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    // Not a git repository: nothing to bind.
    return undefined;
  }
}

/** The bwrap argv that starts the sandbox, before `Connection` appends `serve --token`. */
export function sandboxCommand(cwd: string, daemon: string, config: SandboxManifest): string[] {
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
    // The host home is private; only the declared mounts below enter it.
    "--tmpfs",
    home,
    ...config.mount.flatMap(({ path, readonly }) => [
      readonly === true ? "--ro-bind" : "--bind",
      path,
      path,
    ]),
    "--bind",
    cwd,
    cwd,
    ...(gitDir === undefined ? [] : ["--bind", gitDir, gitDir]),
    // The daemon lives in the pnpm store, which is writable by design: make the binary itself read-only.
    "--ro-bind",
    daemon,
    daemon,
    "--clearenv",
    "--setenv",
    "HOME",
    home,
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "XDG_RUNTIME_DIR",
    runtimeDirectory,
    ...Object.entries(config.env).flatMap(([name, value]) => ["--setenv", name, value]),
    "--die-with-parent",
    "--chdir",
    cwd,
    "--",
    daemon,
  ];
}

/** Open one conversation's sandbox: its connection starts lazily and restarts after loss. */
export function openSandbox(
  conversationId: ConversationId,
  cwd: string,
  daemon: string,
  config: SandboxManifest,
): Sandbox {
  const connection = new Connection({
    command: sandboxCommand(cwd, daemon, config),
    onLog: (text) => console.error("sandbox:", text),
  });
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
  config: SandboxManifest,
  context: Context,
  open: typeof openSandbox = openSandbox,
): ExecutionEnv {
  const sandbox = open(conversationId, cwd, daemon, config);
  const { abortSignal: signal } = context;
  if (signal === undefined) throw new Error("sandboxEnv: the context has no abort signal");
  signal.addEventListener("abort", () => sandbox.connection.close(), { once: true });
  return sandbox.env;
}
