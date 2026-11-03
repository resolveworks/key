// The bwrap argv we build; enforcing it is bwrap's job.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { CACHES, sandboxCommand, sandboxEnv } from "../src/sandbox.ts";

const context = BACKGROUND_CONTEXT;
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
  // The pre-commit hook exports GIT_DIR for the repository it commits, and the probe asks git about
  // cwd: a sandbox daemon started by hand carries no such thing.
  beforeAll(() => {
    for (const name of Object.keys(process.env))
      if (name.startsWith("GIT_")) delete process.env[name];
  });

  test("binds the writable paths over the read-only host and changes directory last", () => {
    const cwd = temp("key-sandbox-order-");
    const command = sandboxCommand(cwd, daemon);
    const root = indexOf(command, "--ro-bind", "/", "/");

    expect(root).toBeGreaterThanOrEqual(0);
    for (const path of [cwd, ...CACHES]) {
      expect(indexOf(command, "--bind", path, path)).toBeGreaterThan(root);
    }
    const tmpfs = indexOf(command, "--tmpfs", "/tmp");
    expect(tmpfs).toBeGreaterThan(root);
    expect(indexOf(command, "--tmpfs", join("/run/user", String(userInfo().uid)))).toBeGreaterThan(
      tmpfs,
    );
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

    const command = sandboxCommand(worktree, daemon);
    const gitDir = join(repository, ".git");

    expect(indexOf(command, "--bind", worktree, worktree)).toBeGreaterThanOrEqual(0);
    expect(indexOf(command, "--bind", gitDir, gitDir)).toBeGreaterThanOrEqual(0);
  });

  test("binds no git dir when the cwd is not a repository", () => {
    const cwd = temp("key-sandbox-plain-");
    const command = sandboxCommand(cwd, daemon);
    const binds = command.flatMap((token, index) =>
      token === "--bind" ? [command[index + 1]] : [],
    );

    expect(binds).toEqual([cwd, ...CACHES]);
  });
});

/** A real connection that counts its closes; the daemon it names never starts. */
class CountingConnection extends Connection {
  closes = 0;
  constructor() {
    super({ command: [daemon] });
  }
  override close(): void {
    this.closes++;
    super.close();
  }
}

describe("sandboxEnv", () => {
  test("the connection closes on the abort signal, and not before", async () => {
    const controller = new AbortController();
    const connection = new CountingConnection();
    const env = new RemoteExecutionEnv({ connection, id: "counting", cwd: "/cwd" });
    sandboxEnv(
      7 as ConversationId,
      "/cwd",
      daemon,
      withAbortSignal(controller.signal, context),
      () => ({ connection, env }),
    );

    expect(connection.closes).toBe(0);

    controller.abort();
    expect(connection.closes).toBe(1);
    await expect(connection.info()).rejects.toThrow("Connection closed");
  });
});
