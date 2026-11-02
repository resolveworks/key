// A restart is the crash-recovery path: a new Harness on the same storage takes up the work the
// first one left, and nothing it already committed happens twice.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  type Harness,
  MemoryStorage,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEnv, REPO } from "./git.ts";
import {
  cascade,
  conversationOf,
  entries,
  keySetup,
  MODEL,
  openKey,
  requestText,
  route,
  unanswered,
} from "./harness.ts";

const context = BACKGROUND_CONTEXT;

/** In-memory storage a second Harness can open again: the records outlive the Session that wrote them. */
class ReopenableStorage extends MemoryStorage {
  reopen(): this {
    (this as unknown as { closed: boolean }).closed = false;
    return this;
  }
}

const opened: Harness[] = [];

afterEach(async () => {
  for (const harness of opened.splice(0)) await harness.close(context);
});

/** Close one host process and start its replacement on the same storage: that is a restart. */
async function restart(
  storage: ReopenableStorage,
  harness: Harness,
  setup: ReturnType<typeof keySetup>,
  env: FakeEnv,
) {
  await harness.close(context);
  opened.splice(opened.indexOf(harness), 1);
  storage.reopen();
  return openKey(storage, setup, env);
}

const nameOf = (record: { readonly input: unknown }) => {
  const input = record.input as { readonly kind?: string; readonly name?: string };
  return input.kind === "worker" ? input.name : undefined;
};

/** Start one prompt directly in an ownerless conversation. */
async function run(
  harness: Harness,
  prompt: string,
): Promise<{ readonly submission: SubmissionId; readonly conversation: ConversationId }> {
  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model: MODEL, cwd: REPO } },
    context,
  );
  const submission = await conversation.submit({ type: "input", content: prompt }, context);
  return { submission: submission.id, conversation: conversation.id };
}

describe("restart", () => {
  it("a direct submission resumes in the same conversation", async () => {
    const setup = keySetup();
    const env = new FakeEnv();
    const storage = new ReopenableStorage();
    const first = await openKey(storage, setup, env);
    opened.push(first);
    const busy = unanswered();
    setup.faux.setResponses([busy.step]);
    const { submission, conversation } = await run(first, "write the report");
    first.resume();
    await busy.reached;
    expect((await entries(first, conversation)).map((entry) => entry.kind)).toEqual([
      "pi.user",
      "pi.system",
    ]);
    const before = await first.commit(
      async (tx) => (await tx.scanConversations({}, 100)).items,
      context,
    );

    const second = await restart(storage, first, setup, env);
    opened.push(second);
    setup.faux.setResponses([fauxAssistantMessage("the report")]);
    second.resume();
    const resumed = await second.submission(submission, context);
    if (resumed === undefined) throw new Error(`no submission #${submission}`);
    expect((await resumed.wait(context)).status).toBe("done");
    const after = await second.commit(
      async (tx) => (await tx.scanConversations({}, 100)).items,
      context,
    );
    expect(after).toEqual(before);
    expect((await entries(second, conversation)).map((entry) => entry.kind)).toEqual([
      "pi.user",
      "pi.system",
      "pi.assistant",
    ]);
  });

  it("children and their successor survive a restart exactly once", async () => {
    const setup = keySetup();
    const env = new FakeEnv();
    const storage = new ReopenableStorage();
    const first = await openKey(storage, setup, env);
    opened.push(first);
    const childA = unanswered();
    const childB = unanswered();
    const answering = route(fauxAssistantMessage("delegated"), {
      "do a": childA.step,
      "do b": childB.step,
    });
    setup.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("delegate", { name: "kid-a", prompt: "do a" }, { id: "call-a" }),
          fauxToolCall("delegate", { name: "kid-b", prompt: "do b" }, { id: "call-b" }),
        ],
        { stopReason: "toolUse" },
      ),
      answering,
      answering,
      answering,
    ]);
    const { submission } = await run(first, "split the work");
    first.resume();
    const initial = await first.submission(submission, context);
    if (initial === undefined) throw new Error(`no submission #${submission}`);
    expect((await initial.wait(context)).status).toBe("done");
    const minted = await vi.waitFor(async () => {
      const records = await cascade(first);
      expect(
        records.filter(
          (record) => (record.input as { readonly kind?: string }).kind === "successor",
        ),
      ).toHaveLength(1);
      return records;
    });
    expect(minted.filter((record) => nameOf(record) !== undefined).map(nameOf)).toEqual([
      "kid-a",
      "kid-b",
    ]);
    const conversations = new Map(
      await Promise.all(
        minted
          .filter((record) => nameOf(record) !== undefined)
          .map(async (record) => [record.id, await conversationOf(first, record.id)] as const),
      ),
    );

    const second = await restart(storage, first, setup, env);
    opened.push(second);
    const finish: FauxResponseStep = (request) => {
      const text = requestText(request.messages);
      if (text.includes("do a")) return fauxAssistantMessage("child a done");
      if (text.includes("do b")) return fauxAssistantMessage("child b done");
      return fauxAssistantMessage("successor done");
    };
    setup.faux.setResponses([finish, finish, finish]);
    second.resume();
    const after = await vi.waitFor(async () => {
      const current = await cascade(second);
      expect(current).toHaveLength(minted.length);
      for (const record of current) expect(record.state.status).toBe("terminal");
      return current;
    });
    expect(after.map((record) => record.id).sort()).toEqual(
      minted.map((record) => record.id).sort(),
    );
    const children = after.filter((record) => nameOf(record) !== undefined);
    expect(children.map(nameOf)).toEqual(["kid-a", "kid-b"]);
    const successors = after.filter(
      (record) => (record.input as { readonly kind?: string }).kind === "successor",
    );
    expect(successors).toHaveLength(1);
    expect(successors[0]?.input).toMatchObject({
      kind: "successor",
      on: children.map((record) => record.id),
    });
    for (const child of children) {
      expect(await conversationOf(second, child.id)).toBe(conversations.get(child.id));
    }
  });

  it("an ask interrupted by a restart resumes in its one fork", async () => {
    const setup = keySetup();
    const env = new FakeEnv();
    const storage = new ReopenableStorage();
    const first = await openKey(storage, setup, env);
    opened.push(first);
    const main = await first.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: MODEL, cwd: REPO } },
      context,
    );
    const hung = unanswered();
    const asking = route(
      (request) =>
        request.messages.at(-1)?.role === "toolResult"
          ? fauxAssistantMessage("done after ask")
          : fauxAssistantMessage(
              fauxToolCall("ask", { conversation: main.id, question: "WHY-ASK" }),
              { stopReason: "toolUse" },
            ),
      { "WHY-ASK": hung.step },
    );
    setup.faux.setResponses([asking, asking, asking]);
    const submission = await main.submit({ type: "input", content: "kick off" }, context);
    first.resume();
    await hung.reached;

    const second = await restart(storage, first, setup, env);
    opened.push(second);
    const finish: FauxResponseStep = (request) => {
      const text = requestText(request.messages);
      if (text.includes("WHY-ASK")) return fauxAssistantMessage("ANSWER-FROM-FROZEN");
      return fauxAssistantMessage("done after ask");
    };
    setup.faux.setResponses([finish, finish, finish]);
    second.resume();
    const resumed = await second.submission(submission.id, context);
    if (resumed === undefined) throw new Error(`no submission #${submission.id}`);
    expect((await resumed.wait(context)).status).toBe("done");

    // The rerun reattached to the first fork and resent nothing: one fork, one question, no ask task.
    const picture = await second.commit(async (tx) => {
      const forks = (await tx.scanConversations({}, 100)).items.filter(
        (item) => item.parent?.conversationId === main.id,
      );
      return {
        asks: (await tx.scanTasks({ kind: "key.ask" }, 10)).items.length,
        forks: await Promise.all(
          forks.map(async (fork) => {
            const owner = fork.owner?.taskId;
            const entries = await tx.scanEntries(
              { conversationId: fork.id, order: "ascending" },
              100,
            );
            return {
              owner: owner === undefined ? undefined : (await tx.task(owner))?.kind,
              questions: entries.items.filter(
                (entry) => entry.kind === "pi.user" && entry.conversationId === fork.id,
              ),
            };
          }),
        ),
      };
    }, context);
    expect(picture.asks).toBe(0);
    expect(picture.forks).toHaveLength(1);
    expect(picture.forks[0]?.owner).toBe("pi.tool");
    expect(picture.forks[0]?.questions).toHaveLength(1);
    const transcript = JSON.stringify(await entries(second, main.id));
    expect(transcript).toContain("ANSWER-FROM-FROZEN");
  });
});
