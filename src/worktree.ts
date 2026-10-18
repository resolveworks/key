// A child's isolated checkout: a git worktree named after the child, on branch agent/<name>.

import { join } from "node:path";
import type { Git } from "./git.ts";

/** Lowercase kebab-case, the name the branch and the directory use. */
export const CHILD_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const BRANCH_PREFIX = "agent/";

export type Worktree = { readonly path: string; readonly branch: string };

/** The branch a child with this name works on. */
export function branchFor(name: string): string {
	return `${BRANCH_PREFIX}${name}`;
}

/** Create the child's worktree in the repository at `cwd`, or accept the one a crashed attempt made. */
export async function ensureWorktree(name: string, git: Git, cwd: string): Promise<Worktree> {
	if (!CHILD_NAME.test(name))
		throw new Error(`key: child name "${name}" must be lowercase kebab-case`);
	const branch = branchFor(name);
	const repo = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
	// Inside the repository, so project-file discovery still reaches AGENTS.md above it.
	const path = join(repo, ".key", "worktrees", name);
	if (await registered(path, branch, git, cwd)) return { path, branch };
	await git(["worktree", "add", "--quiet", "-b", branch, path, "HEAD"], cwd);
	return { path, branch };
}

/** Whether the worktree list already holds this path on this branch. */
async function registered(path: string, branch: string, git: Git, cwd: string): Promise<boolean> {
	const list = await git(["worktree", "list", "--porcelain"], cwd);
	return list.split("\n\n").some((block) => {
		const lines = block.split("\n");
		return lines.includes(`worktree ${path}`) && lines.includes(`branch refs/heads/${branch}`);
	});
}
