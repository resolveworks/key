// A child's isolated checkout: a git worktree named after the child, on branch agent/<name>.
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** Lowercase kebab-case, the name the branch and the directory use. */
export const CHILD_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const BRANCH_PREFIX = "agent/";

export type Worktree = { readonly path: string; readonly branch: string };

/** The branch a child with this name works on. */
export function branchFor(name: string): string {
	return `${BRANCH_PREFIX}${name}`;
}

/** Create the child's worktree, or accept the one a crashed attempt already created. */
export async function ensureWorktree(
	name: string,
	env: ExecutionEnv,
	context: Context,
): Promise<Worktree> {
	if (!CHILD_NAME.test(name))
		throw new Error(`key: child name "${name}" must be lowercase kebab-case`);
	const branch = branchFor(name);
	// Inside the repository, so project-file discovery still reaches AGENTS.md above it.
	const path = join(env.cwd, ".key", "worktrees", name);
	if (await registered(env, path, branch, context)) return { path, branch };
	await git(env, ["worktree", "add", "--quiet", "-b", branch, path, "HEAD"], context);
	return { path, branch };
}

/** Whether the worktree list already holds this path on this branch. */
async function registered(
	env: ExecutionEnv,
	path: string,
	branch: string,
	context: Context,
): Promise<boolean> {
	const list = await git(env, ["worktree", "list", "--porcelain"], context);
	return list.split("\n\n").some((block) => {
		const lines = block.split("\n");
		return lines.includes(`worktree ${path}`) && lines.includes(`branch refs/heads/${branch}`);
	});
}

/** Run git without a shell; the timeout leaves room for repository-owned checkout hooks. */
async function git(env: ExecutionEnv, args: readonly string[], context: Context): Promise<string> {
	let output = "";
	const result = await env.exec(
		["git", ...args],
		{
			timeout: 600,
			onOutput: (text) => {
				output += text;
			},
		},
		context,
	);
	if (!result.ok) throw result.error;
	if (result.value.exitCode !== 0)
		throw new Error(`key: git ${args[0]} failed (exit ${result.value.exitCode}): ${output.trim()}`);
	return output;
}
