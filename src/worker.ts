// A worker's isolated checkout: a git worktree keyed by the delegate call's task id, on
// branch worker/<name> — cut fresh, or checked out again when an earlier cascade left the branch.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TaskId } from "@earendil-works/pi-durable";
import { worktreesDir } from "./config.ts";
import type { Git } from "./git.ts";

export const WORKER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A worker's branch, derived from its name: identity is the name, never a stored ref. */
export function workerBranch(name: string): string {
  return `worker/${name}`;
}

/** The worker's checkout in `cwd`'s repository, or the one a crash left. */
export async function ensureWorker(
  name: string,
  taskId: TaskId,
  git: Git,
  cwd: string,
): Promise<string> {
  const path = join(worktreesDir(), String(taskId));
  if (!existsSync(path)) {
    const branch = workerBranch(name);
    const ref = `refs/heads/${branch}`;
    const kept = (await git(["for-each-ref", "--format=%(objectname)", ref], cwd)).trim();
    if (kept === "") await git(["worktree", "add", "--quiet", "-b", branch, path, "HEAD"], cwd);
    else await git(["worktree", "add", "--quiet", path, branch], cwd);
  }
  return path;
}
