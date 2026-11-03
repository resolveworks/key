// A worker runs in a worktree under the key home, outside the repo, on its own branch.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  type AgentState,
  type ConversationRecord,
  type Harness,
  MemoryStorage,
  type TaskId,
} from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_INSTRUCTIONS } from "../src/system.ts";
import { ensureWorker } from "../src/worker.ts";
import { fakeGit, gitCalls, REPO, resetGit, setGitRefs } from "./git.ts";
import {
  CONVERSATION_TASK,
  conversationOf,
  keySetup,
  MODEL,
  openKey,
  requestText,
} from "./harness.ts";

const context = BACKGROUND_CONTEXT;

describe("ensureWorker", () => {
  beforeEach(resetGit);

  it("creates a worktree under .key keyed by the task, on branch worker/<name>", async () => {
    const worker = await ensureWorker("fix-the-bug", 7 as TaskId, fakeGit, REPO);
    expect(worker).toEqual({
      path: join(homedir(), ".key", "worktrees", "7"),
      branch: "worker/fix-the-bug",
      base: "base-commit",
    });
    expect(gitCalls()).toEqual([
      ["for-each-ref", "--format=%(objectname)", "refs/heads/worker/fix-the-bug"],
      ["worktree", "add", "--quiet", "-b", "worker/fix-the-bug", worker.path, "HEAD"],
      ["rev-parse", "HEAD"],
    ]);
  });

  it("checks out the branch an earlier cascade left instead of cutting a new one", async () => {
    setGitRefs("kept-commit\n");
    const worker = await ensureWorker("x", 7 as TaskId, fakeGit, REPO);
    expect(gitCalls()).toContainEqual(["worktree", "add", "--quiet", worker.path, "worker/x"]);
    expect(worker).toEqual({
      path: join(homedir(), ".key", "worktrees", "7"),
      branch: "worker/x",
      base: "base-commit",
    });
  });

  it("accepts the checkout a crashed attempt left for the same task", async () => {
    // A rented home: the real ~/.key is read-only inside a worker's sandbox.
    const home = mkdtempSync(join(tmpdir(), "key-home-"));
    const path = join(home, ".key", "worktrees", "9000001");
    mkdirSync(path, { recursive: true });
    vi.stubEnv("HOME", home);
    try {
      const worker = await ensureWorker("fix-the-bug", 9_000_001 as TaskId, fakeGit, REPO);
      expect(worker.path).toBe(path);
      expect(gitCalls().filter(([verb]) => verb === "worktree")).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keys two same-named workers in two repositories by their tasks", async () => {
    const here = await ensureWorker("same-name", 7 as TaskId, fakeGit, REPO);
    const there = await ensureWorker("same-name", 8 as TaskId, fakeGit, "/elsewhere/repo");
    expect(here.path).not.toBe(there.path);
    expect(here.branch).toBe("worker/same-name");
    expect(there.branch).toBe("worker/same-name");
    expect(gitCalls().filter(([, verb]) => verb === "add")).toHaveLength(2);
  });
});

describe("a worker's run", () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.close(context);
  });

  async function runWorker(name: string): Promise<{
    readonly harness: Harness;
    readonly task: TaskId;
    readonly conversation: ConversationRecord;
  }> {
    const setup = keySetup();
    const answer: FauxResponseStep = (request) => {
      const text = requestText(request.messages);
      if (text.includes("Successor of conversation") || text.includes("ask the worker"))
        return fauxAssistantMessage("done");
      if (request.messages.at(-1)?.role === "toolResult")
        return fauxAssistantMessage("parent done");
      return fauxAssistantMessage(fauxToolCall("delegate", { name, prompt: "ask the worker" }), {
        stopReason: "toolUse",
      });
    };
    setup.faux.setResponses([answer, answer, answer, answer]);
    const harness = await openKey(new MemoryStorage(), setup);
    harnesses.push(harness);
    const root = await harness.root(context, { agent: { model: MODEL, cwd: REPO } });
    const submission = await root.submit({ type: "input", content: "start the worker" }, context);
    expect((await submission.wait(context)).status).toBe("done");
    const task = await harness.commit(async (tx) => {
      const records = await tx.scanTasks({ kind: CONVERSATION_TASK }, 100);
      const child = records.items.find((record) => {
        const input = record.input as { readonly kind?: string; readonly branch?: string };
        return input.kind === "worker" && input.branch === `worker/${name}`;
      });
      if (child === undefined) throw new Error(`no worker ${name}`);
      return child.id;
    }, context);
    await harness.waitForTask(task, context);
    const conversation = await harness.conversation(await conversationOf(harness, task), context);
    if (conversation === undefined) throw new Error(`no conversation for task #${task}`);
    return { harness, task, conversation };
  }

  async function agentState(
    harness: Harness,
    id: ConversationRecord["id"],
  ): Promise<AgentState | undefined> {
    const conversation = await harness.conversation(id, context);
    const watch = await conversation?.watch(context);
    return watch?.value.docs["pi.agent"] as AgentState | undefined;
  }

  it("runs inside its worktree", async () => {
    const { harness, conversation } = await runWorker("fix-the-bug");
    const agent = await agentState(harness, conversation.id);
    const tools = await harness.commit((tx) => tx.scanTasks({ kind: "pi.tool" }, 100), context);
    expect(tools.items).toHaveLength(1);
    expect(agent?.cwd).toBe(join(homedir(), ".key", "worktrees", String(tools.items[0].id)));
    expect(agent?.instructions).toBe(WORKER_INSTRUCTIONS);
  });
});
