// The bwrap argv we build; enforcing it is bwrap's job.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { sandboxCommand, sandboxEnv } from "../src/sandbox.ts";

const daemon = "/daemon";
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

/** Two fresh cache dirs standing in for pnpm and uv stores. */
function caches(): string[] {
  return [join(temp("key-sandbox-caches-"), "pnpm"), join(temp("key-sandbox-caches-"), "uv")].map(
    (path) => {
      mkdirSync(path, { recursive: true });
      return path;
    },
  );
}

function indexOf(command: readonly string[], ...tokens: string[]): number {
  outer: for (let index = 0; index <= command.length - tokens.length; index++) {
    for (let offset = 0; offset < tokens.length; offset++) {
      if (command[index + offset] !== tokens[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

describe("sandboxCommand", () => {
  test("binds the writable paths over the read-only host and changes directory last", () => {
    const cwd = temp("key-sandbox-order-");
    const [pnpm, uv] = caches();
    const command = sandboxCommand(cwd, daemon, [pnpm, uv]);
    const root = indexOf(command, "--ro-bind", "/", "/");

    expect(root).toBeGreaterThanOrEqual(0);
    for (const path of [cwd, pnpm, uv]) {
      expect(indexOf(command, "--bind", path, path)).toBeGreaterThan(root);
    }
    const tmpfs = indexOf(command, "--tmpfs", "/tmp");
    expect(tmpfs).toBeGreaterThan(root);
    expect(indexOf(command, "--chdir", cwd)).toBeGreaterThan(tmpfs);
    expect(indexOf(command, "--bind", "/tmp", "/tmp")).toBe(-1);
  });

  test("binds the main repository's git dir for a linked worktree", () => {
    const base = temp("key-sandbox-git-");
    const repository = join(base, "repository");
    const worktree = join(base, "worktree");
    mkdirSync(repository);
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
    const git = (args: readonly string[], cwd: string) =>
      execFileSync("git", args, {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    git(["init", "--quiet"], repository);
    git(["config", "user.email", "sandbox@example.com"], repository);
    git(["config", "user.name", "Sandbox"], repository);
    writeFileSync(join(repository, "first"), "first\n");
    git(["add", "first"], repository);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "first"], repository);
    git(["worktree", "add", "--quiet", "-b", "sandbox", worktree, "HEAD"], repository);

    const command = sandboxCommand(worktree, daemon, caches());
    const gitDir = join(repository, ".git");

    expect(indexOf(command, "--bind", worktree, worktree)).toBeGreaterThanOrEqual(0);
    expect(indexOf(command, "--bind", gitDir, gitDir)).toBeGreaterThanOrEqual(0);
  });
});

describe("sandboxEnv", () => {
  test("points the package managers at the writable caches and signs git off", () => {
    const [pnpm, uv] = caches();
    expect(sandboxEnv([pnpm, uv])).toEqual({
      pnpm_config_store_dir: join(pnpm, "store"),
      pnpm_config_enable_global_virtual_store: "true",
      UV_PREVIEW_FEATURES: "centralized-project-envs",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "tag.gpgsign",
      GIT_CONFIG_VALUE_1: "false",
    });
  });

  test("drops the package-manager vars when their caches are not injected", () => {
    const env = sandboxEnv([temp("key-sandbox-env-")]);
    expect(env.pnpm_config_store_dir).toBeUndefined();
    expect(env.UV_PREVIEW_FEATURES).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBe("2");
  });
});
