// One real bwrap sandbox per test: its writable surface is the worktree, the caches and /tmp; home is read-only.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Connection, localDaemon } from "@earendil-works/pi-env";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { openSandbox, sandboxCommand } from "../src/sandbox.ts";

const context = BACKGROUND_CONTEXT;
const daemon = localDaemon();
const temporary: string[] = [];

beforeAll(() => {
  if (!existsSync(daemon))
    throw new Error(
      `sandbox tests need the pi-env daemon: run \`pnpm build:env\` first (${daemon})`,
    );
});

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function atHome(prefix: string): string {
  const path = mkdtempSync(join(homedir(), prefix));
  temporary.push(path);
  return path;
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
    const cwd = atHome(".key-sandbox-order-");
    const command = sandboxCommand(cwd, daemon);
    const root = indexOf(command, "--ro-bind", "/", "/");

    expect(root).toBeGreaterThanOrEqual(0);
    for (const path of [
      cwd,
      join(homedir(), ".local/share/pnpm"),
      join(homedir(), ".cache/uv"),
      join(homedir(), ".local/share/uv"),
      join(homedir(), ".cargo"),
    ]) {
      expect(indexOf(command, "--bind", path, path)).toBeGreaterThan(root);
    }
    expect(indexOf(command, "--chdir", cwd)).toBeGreaterThan(
      indexOf(command, "--bind", "/tmp", "/tmp"),
    );
    expect(command).not.toContain("--tmpfs");
  });
});

describe("a sandbox", () => {
  test("writes reach the host and the host home is readable but not writable", async () => {
    const cwd = temp("key-sandbox-write-");
    const marker = atHome(".key-sandbox-marker-");
    writeFileSync(join(marker, "host-only"), "host");
    const { connection, env } = openSandbox(1 as ConversationId, cwd, daemon);
    try {
      const shell = await env.exec(["touch", join(cwd, "shell.txt")], undefined, context);
      expect(shell.ok).toBe(true);
      if (shell.ok) expect(shell.value.exitCode).toBe(0);
      expect(existsSync(join(cwd, "shell.txt"))).toBe(true);

      const written = await env.writeFile("fs.txt", "from the daemon", context);
      expect(written.ok).toBe(true);
      expect(readFileSync(join(cwd, "fs.txt"), "utf8")).toBe("from the daemon");

      const visible = await env.exists(join(marker, "host-only"), context);
      expect(visible.ok).toBe(true);
      if (visible.ok) expect(visible.value).toBe(true);

      const denied = await env.writeFile(join(marker, "new"), "no", context);
      expect(denied.ok).toBe(false);
      expect(existsSync(join(marker, "new"))).toBe(false);
    } finally {
      connection.close();
    }
  });

  test("writing outside the writable mounts fails", async () => {
    const cwd = temp("key-sandbox-outside-");
    const { connection, env } = openSandbox(2 as ConversationId, cwd, daemon);
    try {
      const outside = join("/", `key-sandbox-outside-${process.pid}`);
      const written = await env.writeFile(outside, "not allowed", context);
      expect(written.ok).toBe(false);
      expect(existsSync(outside)).toBe(false);
    } finally {
      connection.close();
    }
  });

  test("a linked worktree can run git status and commit", async () => {
    const base = atHome(".key-sandbox-git-");
    const repository = join(base, "repository");
    const worktree = join(base, "worktree");
    mkdirSync(repository);
    const gitEnv = { ...process.env };
    for (const name of Object.keys(gitEnv)) if (name.startsWith("GIT_")) delete gitEnv[name];
    const git = (args: readonly string[], cwd: string) =>
      execFileSync("git", args, {
        cwd,
        env: gitEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    git(["init", "--quiet"], repository);
    git(["config", "commit.gpgsign", "false"], repository);
    git(["config", "tag.gpgsign", "false"], repository);
    git(["config", "user.email", "sandbox@example.com"], repository);
    git(["config", "user.name", "Sandbox"], repository);
    writeFileSync(join(repository, "first"), "first\n");
    git(["add", "first"], repository);
    git(["commit", "--quiet", "-m", "first"], repository);
    git(["worktree", "add", "--quiet", "-b", "sandbox", worktree, "HEAD"], repository);

    const { connection, env } = openSandbox(3 as ConversationId, worktree, daemon);
    try {
      const status = await env.exec(["git", "status", "--porcelain"], undefined, context);
      expect(status.ok).toBe(true);
      if (status.ok) expect(status.value.exitCode).toBe(0);

      writeFileSync(join(worktree, "second"), "second\n");
      const add = await env.exec(["git", "add", "second"], undefined, context);
      expect(add.ok).toBe(true);
      if (add.ok) expect(add.value.exitCode).toBe(0);

      const commit = await env.exec(["git", "commit", "-m", "second"], undefined, context);
      expect(commit.ok).toBe(true);
      if (commit.ok) expect(commit.value.exitCode).toBe(0);
      expect(git(["log", "-1", "--format=%s"], worktree).trim()).toBe("second");
    } finally {
      connection.close();
    }
  });

  test("a missing bwrap or daemon fails the connection", async () => {
    const cwd = temp("key-sandbox-missing-");

    const noBwrap = new Connection({ command: [join(cwd, "no-bwrap")] });
    try {
      await expect(noBwrap.info()).rejects.toThrow();
    } finally {
      noBwrap.close();
    }

    const { connection } = openSandbox(4 as ConversationId, cwd, join(cwd, "no-daemon"));
    try {
      await expect(connection.info()).rejects.toThrow();
    } finally {
      connection.close();
    }
  });
});
