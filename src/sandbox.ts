// One conversation's bubblewrap sandbox: a read-only host, the worktree and the caches writable.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";

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

/**
 * The environment every sandboxed command inherits: package stores pointed at
 * the writable caches, signing off inside the bubble.
 */
export function sandboxEnv(caches: readonly string[]): Record<string, string> {
  const pnpm = caches.find((dir) => basename(dir) === "pnpm");
  const uv = caches.some((dir) => basename(dir).includes("uv"));
  return {
    ...(pnpm === undefined
      ? {}
      : {
          pnpm_config_store_dir: join(pnpm, "store"),
          pnpm_config_enable_global_virtual_store: "true",
        }),
    ...(uv ? { UV_PREVIEW_FEATURES: "centralized-project-envs" } : {}),
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "tag.gpgsign",
    GIT_CONFIG_VALUE_1: "false",
  };
}

/** The bwrap argv that starts the sandbox, before `Connection` appends `serve --token`. */
export function sandboxCommand(cwd: string, daemon: string, caches: readonly string[]): string[] {
  for (const path of caches) mkdirSync(path, { recursive: true });
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
    ...caches.flatMap((path) => ["--bind", path, path]),
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
  caches: readonly string[],
): Sandbox {
  const connection = new Connection({ command: sandboxCommand(cwd, daemon, caches) });
  const env = new RemoteExecutionEnv({
    connection,
    id: `bwrap:${conversationId}`,
    cwd,
    shellEnv: sandboxEnv(caches),
  });
  return { connection, env };
}
