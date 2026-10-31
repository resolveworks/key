import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { branchOf } from "../src/host.ts";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

describe("branchOf", () => {
  test("a plain repository reports its branch", async () => {
    const repo = mkdtempSync(join(tmpdir(), "key-branch-"));
    run(repo, "init", "-b", "trunk");
    await expect(branchOf(repo)).resolves.toBe("trunk");
  });

  test("a subdirectory walks up to the repository", async () => {
    const repo = mkdtempSync(join(tmpdir(), "key-branch-"));
    run(repo, "init", "-b", "trunk");
    await expect(branchOf(join(repo, "nested", "deeper"))).resolves.toBe("trunk");
  });

  test("a linked worktree reports its own branch", async () => {
    const repo = mkdtempSync(join(tmpdir(), "key-branch-"));
    run(repo, "init", "-b", "trunk");
    run(repo, "commit", "--allow-empty", "-m", "kickoff");
    run(repo, "worktree", "add", "-b", "forked", `${repo}-wt`);
    await expect(branchOf(`${repo}-wt`)).resolves.toBe("forked");
  });

  test("a detached HEAD is no branch", async () => {
    const repo = mkdtempSync(join(tmpdir(), "key-branch-"));
    run(repo, "init", "-b", "trunk");
    run(repo, "commit", "--allow-empty", "-m", "kickoff");
    run(repo, "checkout", "--detach");
    await expect(branchOf(repo)).resolves.toBeUndefined();
  });

  test("a plain directory with no repository is no branch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "key-branch-"));
    await expect(branchOf(dir)).resolves.toBeUndefined();
  });
});
