// The host's git, as one function: the port tests fake and the host binds when it installs key.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Run git without a shell in `cwd` and answer its stdout; a nonzero exit is an error. */
export type Git = (args: readonly string[], cwd: string) => Promise<string>;

/** The timeout leaves room for repository-owned checkout hooks. */
export const git: Git = async (args, cwd) => {
  try {
    return (await run("git", args, { cwd, timeout: 600_000 })).stdout;
  } catch (error) {
    const failed = error as { code?: number | string; stderr?: string; message: string };
    throw new Error(
      `key: git ${args[0]} failed (exit ${failed.code}): ${`${failed.stderr ?? ""}${failed.message}`.trim()}`,
    );
  }
};
