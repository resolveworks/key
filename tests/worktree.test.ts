// A child runs in a worktree under the key home, outside the repo, on its own branch.
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
import { branchFor, ensureWorktree } from "../src/worktree.ts";
import { fakeGit, gitCalls, REPO, resetGit } from "./git.ts";
import { conversationOf, KeyTask, keySetup, MODEL, openKey, requestText } from "./harness.ts";

const context = BACKGROUND_CONTEXT;

describe("ensureWorktree", () => {
  beforeEach(resetGit);

  it("asks git for a worktree under .key, on branch agent/<name>", async () => {
    const tree = await ensureWorktree("fix-the-bug", fakeGit, REPO);
    expect(tree).toEqual({
      path: join(homedir(), ".key", "worktrees", "fix-the-bug"),
      branch: branchFor("fix-the-bug"),
    });
    expect(gitCalls()).toContainEqual([
      "worktree",
      "add",
      "--quiet",
      "-b",
      "agent/fix-the-bug",
      tree.path,
      "HEAD",
    ]);
  });

  it("a name that is not kebab-case fails loudly", async () => {
    await expect(ensureWorktree("Not Kebab", fakeGit, REPO)).rejects.toThrow(
      /lowercase kebab-case/,
    );
    expect(gitCalls()).toEqual([]);
  });
});

describe("a child's run", () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.close(context);
  });

  /** Fork one child through the model, then return its task and conversation. */
  async function runChild(name: string): Promise<{
    readonly harness: Harness;
    readonly task: TaskId;
    readonly conversation: ConversationRecord;
  }> {
    const setup = keySetup();
    const answer: FauxResponseStep = (request) => {
      const text = requestText(request.messages);
      if (text.includes("Successor of conversation") || text.includes("ask the child"))
        return fauxAssistantMessage("done");
      if (request.messages.at(-1)?.role === "toolResult")
        return fauxAssistantMessage("parent done");
      return fauxAssistantMessage(fauxToolCall("fork", { name, prompt: "ask the child" }), {
        stopReason: "toolUse",
      });
    };
    setup.faux.setResponses([answer, answer, answer, answer]);
    const harness = await openKey(new MemoryStorage(), setup);
    harnesses.push(harness);
    const root = await harness.root(context, { agent: { model: MODEL, cwd: REPO } });
    const submission = await root.submit({ type: "input", content: "start the child" }, context);
    expect((await submission.wait(context)).status).toBe("done");
    const task = await harness.commit(async (tx) => {
      const records = await tx.scanTasks({ kind: KeyTask.definition.name }, 100);
      const child = records.items.find((record) => {
        const input = record.input as { readonly kind?: string; readonly name?: string };
        return input.kind === "fork" && input.name === name;
      });
      if (child === undefined) throw new Error(`no child ${name}`);
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

  it("a child runs inside the worktree its name creates", async () => {
    const { harness, conversation } = await runChild("fix-the-bug");
    const agent = await agentState(harness, conversation.id);
    expect(agent?.cwd).toBe(join(homedir(), ".key", "worktrees", "fix-the-bug"));
  });
});
