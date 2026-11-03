// The bwrap argv we build; enforcing it is bwrap's job.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import {
  type BinaryReader,
  type FileError,
  getOrThrow,
  type Result,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type Sandbox, sandboxCommand, sandboxEnv } from "../src/sandbox.ts";
import { keySetup, MODEL } from "./harness.ts";

const context = BACKGROUND_CONTEXT;
const daemon = "/daemon";
const temporary: string[] = [];

let opened: Harness | undefined;
let reports: unknown[] = [];

afterEach(async () => {
  await opened?.close(context);
  opened = undefined;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  if (reports.length > 0) throw new Error(`harness reported failures: ${reports.join("\n")}`);
  reports = [];
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
  test("binds the writable paths over the read-only host and changes directory last", () => {
    const cwd = temp("key-sandbox-order-");
    const command = sandboxCommand(cwd, daemon);
    const root = indexOf(command, "--ro-bind", "/", "/");

    expect(root).toBeGreaterThanOrEqual(0);
    for (const path of [
      cwd,
      join(homedir(), ".local/share/pnpm"),
      join(homedir(), ".cache/pnpm"),
      join(homedir(), ".local/state/pnpm"),
      join(homedir(), ".cache/uv"),
      join(homedir(), ".local/share/uv"),
      join(homedir(), ".cargo"),
    ]) {
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
});

/** A connection that only counts its closes; the daemon it names never starts. */
class CountingConnection extends Connection {
  closes = 0;
  constructor() {
    super({ command: ["/daemon"] });
  }
  override close(): void {
    this.closes++;
  }
}

/** One fake sandbox's env: it records the operations that reach it and answers canned results. */
class RecordingEnv extends RemoteExecutionEnv {
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readonly handleReads: number[] = [];
  handle: BinaryReader | undefined;

  constructor(connection: Connection) {
    super({ connection, id: "recording", cwd: "/cwd" });
  }

  override async readTextFile(path: string): Promise<Result<string, FileError>> {
    this.reads.push(path);
    return { ok: true, value: "one invocation's files" };
  }

  override async writeFile(path: string): Promise<Result<void, FileError>> {
    this.writes.push(path);
    return { ok: true, value: undefined };
  }

  override async openBinaryReader(path: string): Promise<Result<BinaryReader, FileError>> {
    const handle: BinaryReader = {
      info: async () => ({
        ok: true,
        value: { name: path, path, kind: "file", size: 4, mtimeMs: 0 },
      }),
      read: async (offset: number, length: number) => {
        this.handleReads.push(length);
        return { ok: true, value: new Uint8Array([0, 1, 2, 3]).slice(offset, offset + length) };
      },
      scanLines: async () => ({
        ok: true,
        value: {
          newlines: 0,
          start: 0,
          end: 4,
          firstLineEnd: 4,
          lastLineStart: 0,
          selectedBytes: 4,
          firstLineBytes: 4,
        },
      }),
      close: async () => {},
    };
    this.handle = handle;
    return { ok: true, value: handle };
  }
}

describe("sandboxEnv", () => {
  test("one sandbox serves the invocation's every operation", async () => {
    const connection = new CountingConnection();
    const env = new RecordingEnv(connection);
    let opens = 0;
    const opener = (): Sandbox => {
      opens++;
      return { connection, env };
    };
    const built = sandboxEnv(
      7 as ConversationId,
      "/cwd",
      daemon,
      withAbortSignal(new AbortController().signal, context),
      opener,
    );

    expect(getOrThrow(await built.readTextFile("/cwd/read", context))).toBe(
      "one invocation's files",
    );
    getOrThrow(await built.writeFile("/cwd/write", "content", context));
    const handle = getOrThrow(await built.openBinaryReader("/cwd/blob", undefined, context));
    expect(getOrThrow(await handle.read(1, 2, context))).toEqual(new Uint8Array([1, 2]));

    expect(opens).toBe(1);
    expect(env.reads).toEqual(["/cwd/read"]);
    expect(env.writes).toEqual(["/cwd/write"]);
    expect(env.handleReads).toEqual([2]);
    expect(handle).toBe(env.handle);
  });

  test("the connection closes once, when the invocation's abort signal fires", async () => {
    const controller = new AbortController();
    const connection = new CountingConnection();
    const env = sandboxEnv(
      7 as ConversationId,
      "/cwd",
      daemon,
      withAbortSignal(controller.signal, context),
      () => ({ connection, env: new RecordingEnv(connection) }),
    );

    getOrThrow(await env.readTextFile("/cwd/read", context));
    expect(connection.closes).toBe(0);

    controller.abort();
    expect(connection.closes).toBe(1);
  });
});

/** The env the real harness asks for: a local env that remembers the signal its build context carried. */
class ProbingEnv extends NodeExecutionEnv {
  readonly signal: AbortSignal;
  wroteWhileAborted: boolean | undefined;

  constructor(cwd: string, signal: AbortSignal) {
    super({ cwd });
    this.signal = signal;
  }

  override async writeFile(
    path: string,
    content: string | Uint8Array,
    writeContext: Context,
  ): Promise<Result<void, FileError>> {
    this.wroteWhileAborted = this.signal.aborted;
    return super.writeFile(path, content, writeContext);
  }
}

describe("the env builder's context", () => {
  test("aborts once the invocation that asked for the env ends", async () => {
    const setup = keySetup();
    reports = setup.reports;
    const built: ProbingEnv[] = [];
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models: setup.models,
        registry: setup.registry,
        env: (target, buildContext) => {
          if (buildContext.abortSignal === undefined)
            throw new Error("the env builder's context has no abort signal");
          if (target.cwd === undefined)
            throw new Error(`conversation ${target.conversationId} has no cwd`);
          const env = new ProbingEnv(target.cwd, buildContext.abortSignal);
          built.push(env);
          return env;
        },
        onReport: (report) => setup.reports.push(report),
      },
      context,
    );
    opened = harness;

    setup.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("write", { path: "probe", content: "through one invocation's env" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("written"),
    ]);
    const conversation = await harness.root(context, {
      agent: { model: MODEL, cwd: temp("key-sandbox-invocation-") },
    });
    harness.resume();
    const submission = await conversation.submit(
      { type: "input", content: "write the probe" },
      context,
    );
    expect((await submission.wait(context)).status).toBe("done");

    const writing = built.filter((env) => env.wroteWhileAborted !== undefined);
    expect(writing).toHaveLength(1);
    expect(writing[0].wroteWhileAborted).toBe(false);
    expect(built.length).toBeGreaterThanOrEqual(2);
    await vi.waitFor(
      () => {
        expect(built.every((env) => env.signal.aborted)).toBe(true);
      },
      { interval: 5 },
    );
  });
});
