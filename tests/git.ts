// Git reduced to a recorder: a test cares that Key issues the right git command, never what git
// does with it. Anything that is not git was never asked for and fails loudly.
import type { Context } from "@earendil-works/chord";
import { ok, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/** Where every path in a test begins: nothing on disk, just the env's `cwd`. */
export const REPO = "/key/repo";

export class FakeGitEnv extends NodeExecutionEnv {
	#calls: readonly (readonly string[])[] = [];

	constructor() {
		super({ cwd: REPO });
	}

	/** Every git invocation, as its argument vector, in order. */
	get calls(): readonly (readonly string[])[] {
		return this.#calls;
	}

	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	) {
		if (typeof command === "string" || command[0] !== "git")
			throw new Error(`fake env: no answer for ${JSON.stringify(command)}`);
		this.#calls = [...this.#calls, command];
		options?.onOutput?.("", context, { stream: "stdout" });
		return ok<ShellExecResult, never>({ exitCode: 0 });
	}
}
