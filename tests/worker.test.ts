// A worker runs in a worktree under the key home, outside the repo, on its own branch.
import { homedir } from "node:os";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKER_INSTRUCTIONS } from "../src/system.ts";
import { ensureWorker, workerBranch } from "../src/worker.ts";
import { fakeGit, gitCalls, REPO, resetGit } from "./git.ts";
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
      branch: workerBranch("fix-the-bug"),
      base: "base-commit",
    });
    expect(gitCalls()).toContainEqual([
      "worktree",
      "add",
      "--quiet",
      "-b",
      workerBranch("fix-the-bug"),
      worker.path,
      "base-commit",
    ]);
  });

  it("reuses the worktree a crashed attempt left for the same task", async () => {
    const first = await ensureWorker("fix-the-bug", 7 as TaskId, fakeGit, REPO);
    const again = await ensureWorker("fix-the-bug", 7 as TaskId, fakeGit, REPO);
    expect(again).toEqual(first);
    expect(gitCalls().filter(([, verb]) => verb === "add")).toHaveLength(1);
  });

  it("keys two same-named workers in two repositories by their tasks", async () => {
    const here = await ensureWorker("same-name", 7 as TaskId, fakeGit, REPO);
    const there = await ensureWorker("same-name", 8 as TaskId, fakeGit, "/elsewhere/repo");
    expect(here.path).not.toBe(there.path);
    expect(here.branch).toBe(workerBranch("same-name"));
    expect(there.branch).toBe(workerBranch("same-name"));
    expect(gitCalls().filter(([, verb]) => verb === "add")).toHaveLength(2);
  });

  it("rejects a name that is not kebab-case", async () => {
    await expect(ensureWorker("Not Kebab", 7 as TaskId, fakeGit, REPO)).rejects.toThrow(
      /lowercase kebab-case/,
    );
    expect(gitCalls()).toEqual([]);
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
        const input = record.input as { readonly kind?: string; readonly name?: string };
        return input.kind === "worker" && input.name === name;
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
