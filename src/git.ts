// The host's git, as one function: the port tests fake and the host binds when it installs key.
import { execFile } from "node:child_process";

/** Run git without a shell in `cwd` and answer its stdout; a nonzero exit is an error. */
export type Git = (args: readonly string[], cwd: string) => Promise<string>;

/** The timeout leaves room for repository-owned checkout hooks. */
export const git: Git = (args, cwd) =>
	new Promise((resolve, reject) => {
		execFile("git", args, { cwd, timeout: 600_000 }, (error, stdout, stderr) => {
			if (error !== null)
				reject(
					new Error(
						`key: git ${args[0]} failed (exit ${error.code}): ${`${stderr}${error.message}`.trim()}`,
					),
				);
			else resolve(stdout);
		});
	});
