// Git reduced to a recorder: a test cares that Key issues the right git command, never what git
// does with it. Anything that is not git was never asked for and fails loudly.
import type { Context } from "@earendil-works/chord";
import type { Result, ShellExecOptions, ShellExecResult } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Git } from "../src/git.ts";

/** Where every path in a test begins: nothing on disk, just the env's `cwd`. */
export const REPO = "/key/repo";

/** The harness environment: nothing on disk, and no test runs a process through it. */
export class FakeEnv extends NodeExecutionEnv {
  constructor() {
    super({ cwd: REPO });
  }

  override async exec(
    command: string | readonly string[],
    _options: ShellExecOptions | undefined,
    _context: Context,
  ): Promise<Result<ShellExecResult, never>> {
    throw new Error(`fake env: no answer for ${JSON.stringify(command)}`);
  }
}

let calls: readonly (readonly string[])[] = [];
let diff = "";
let toplevel = REPO;

/** Every git invocation, as its argument vector, in order. */
export function gitCalls(): readonly (readonly string[])[] {
  return calls;
}

/** Forget the git calls recorded so far. */
export function resetGit(): void {
  calls = [];
  diff = "";
  toplevel = REPO;
}

/** The checkout root the fake answers `rev-parse --show-toplevel` with. */
export function setGitToplevel(path: string): void {
  toplevel = path;
}

export function setGitDiff(value: string): void {
  diff = value;
}

/** The fake git port: records every call and answers the small surface Key consumes. */
export const fakeGit: Git = async (args, _cwd) => {
  calls = [...calls, args];
  if (args[0] === "rev-parse") return args[1] === "HEAD" ? "base-commit\n" : `${toplevel}\n`;
  if (args[0] === "diff") return diff;
  return "";
};
