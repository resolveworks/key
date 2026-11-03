// A worker's isolated checkout: a git worktree keyed by the delegate call's task id, on
// branch worker/<name> — cut fresh, or checked out again when an earlier cascade left the branch.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Git } from "./git.ts";

export type Worker = { readonly path: string; readonly branch: string; readonly base: string };

/** The worker's checkout in `cwd`'s repository, or the one a crash left. */
export async function ensureWorker(
  name: string,
  taskId: TaskId,
  git: Git,
  cwd: string,
): Promise<Worker> {
  const branch = `worker/${name}`;
  const path = join(homedir(), ".key", "worktrees", String(taskId));
  if (!existsSync(path)) {
    const ref = `refs/heads/${branch}`;
    const kept = (await git(["for-each-ref", "--format=%(objectname)", ref], cwd)).trim();
    if (kept === "") await git(["worktree", "add", "--quiet", "-b", branch, path, "HEAD"], cwd);
    else await git(["worktree", "add", "--quiet", path, branch], cwd);
  }
  return { path, branch, base: (await git(["rev-parse", "HEAD"], path)).trim() };
}
