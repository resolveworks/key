// A worker's isolated checkout: a git worktree named after it, on branch worker/<name>.
import { homedir } from "node:os";
import { join } from "node:path";
import type { Git } from "./git.ts";

export const WORKER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const BRANCH_PREFIX = "worker/";

export type Worker = {
  readonly path: string;
  readonly branch: string;
  readonly base: string;
};

export function workerBranch(name: string): string {
  return `${BRANCH_PREFIX}${name}`;
}

/** Create the worker's worktree in the repository at `cwd`, or accept the one a crashed attempt
 * left. */
export async function ensureWorker(name: string, git: Git, cwd: string): Promise<Worker> {
  if (!WORKER_NAME.test(name))
    throw new Error(`key: worker name "${name}" must be lowercase kebab-case`);
  const branch = workerBranch(name);
  const base = (await git(["rev-parse", "HEAD"], cwd)).trim();
  const path = join(homedir(), ".key", "worktrees", name);
  if (await registered(path, branch, git, cwd)) return { path, branch, base };
  await git(["worktree", "add", "--quiet", "-b", branch, path, base], cwd);
  return { path, branch, base };
}

async function registered(path: string, branch: string, git: Git, cwd: string): Promise<boolean> {
  const list = await git(["worktree", "list", "--porcelain"], cwd);
  return list.split("\n\n").some((block) => {
    const lines = block.split("\n");
    return lines.includes(`worktree ${path}`) && lines.includes(`branch refs/heads/${branch}`);
  });
}
