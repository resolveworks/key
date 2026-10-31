import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxProviderHandle, FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  type Harness,
  MemoryStorage,
  type TaskId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REPO } from "./git.ts";
import {
  cascade,
  conversationOf,
  entries,
  interrupt,
  type KeyRecord,
  keySetup,
  MODEL,
  openKey,
  requestText,
  route,
  unanswered,
} from "./harness.ts";

const context = BACKGROUND_CONTEXT;

let opened: Harness | undefined;
let reports: unknown[] = [];

afterEach(async () => {
  await opened?.close(context);
  opened = undefined;
  if (reports.length > 0) throw new Error(`harness reported failures: ${reports.join("\n")}`);
  reports = [];
});

/** One test's harness: the faux model over memory storage, scheduling off until a run asks. */
async function fresh(): Promise<{ readonly faux: FauxProviderHandle; readonly harness: Harness }> {
  const setup = keySetup();
  reports = setup.reports;
  const harness = await openKey(new MemoryStorage(), setup);
  opened = harness;
  return { faux: setup.faux, harness };
}

/** One answer: the forks it calls, then the text its turn ends with. */
function turn(text: string, forks: readonly string[] = []) {
  return fauxAssistantMessage(
    [
      ...forks.map((name) => fauxToolCall("fork", { name, prompt: `task for ${name}` })),
      fauxText(text),
    ],
    { stopReason: forks.length === 0 ? "stop" : "toolUse" },
  );
}

const children = (records: readonly KeyRecord[]) =>
  records.filter((record) => record.input.kind === "fork");
const nameOf = (record: KeyRecord): string | undefined =>
  record.input.kind === "fork" ? record.input.name : undefined;
const onOf = (record: KeyRecord): readonly TaskId<string>[] | undefined =>
  record.input.kind === "successor" ? record.input.on : undefined;

function successor(
  records: readonly KeyRecord[],
  on?: readonly TaskId<string>[],
): KeyRecord | undefined {
  return records.find((record) => {
    const waitingOn = onOf(record);
    return (
      waitingOn !== undefined &&
      (on === undefined ||
        (waitingOn.length === on.length && waitingOn.every((id, index) => id === on[index])))
    );
  });
}

async function conversation(harness: Harness) {
  return harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model: MODEL, cwd: REPO } },
    context,
  );
}

/** Start a prompt directly in a new ownerless conversation. */
async function run(harness: Harness, prompt: string): Promise<ConversationId> {
  const handle = await conversation(harness);
  await handle.submit({ type: "input", content: prompt }, context);
  harness.resume();
  return handle.id;
}

/** Start a prompt and wait for its own answer, not for background cascade work. */
async function started(harness: Harness, prompt: string): Promise<ConversationId> {
  const handle = await conversation(harness);
  const submission = await handle.submit({ type: "input", content: prompt }, context);
  harness.resume();
  expect((await submission.wait(context)).status).toBe("done");
  return handle.id;
}

/** Wait until an answered run has created its successor. */
async function waitForSuccessor(
  harness: Harness,
  on?: readonly TaskId<string>[],
): Promise<KeyRecord> {
  let next: KeyRecord | undefined;
  await vi.waitFor(
    async () => {
      next = successor(await cascade(harness), on);
      expect(next).toBeDefined();
    },
    { interval: 5 },
  );
  return next as KeyRecord;
}

describe("the fork cascade", () => {
  it("one fork call starts one child immediately and then a fresh successor", async () => {
    const { faux, harness } = await fresh();
    const answer = route(turn("a is on its way"), { "task for a": turn("a answers") });
    faux.setResponses([turn("I forked a.", ["a"]), answer, answer, turn("summed")]);

    await started(harness, "kick off");
    const child = children(await cascade(harness))[0];
    const next = await waitForSuccessor(harness, [child.id]);

    expect(child.input).toEqual({ kind: "fork", prompt: "task for a", name: "a" });
    expect(next.input).toEqual({ kind: "successor", on: [child.id] });
    await harness.waitForTask(next.id, context);
  });

  it("several fork calls start several children", async () => {
    const { faux, harness } = await fresh();
    const answer = route(turn("both are underway"), {
      "task for a": turn("a answers"),
      "task for b": turn("b answers"),
    });
    faux.setResponses([
      turn("I forked a and b.", ["a", "b"]),
      answer,
      answer,
      answer,
      turn("summed"),
    ]);

    await started(harness, "kick off");
    const forked = children(await cascade(harness)).sort((left, right) => left.id - right.id);
    const next = await waitForSuccessor(harness);

    expect(forked.map(nameOf)).toEqual(["a", "b"]);
    expect([...(onOf(next) ?? [])].sort()).toEqual(forked.map((record) => record.id).sort());
    await harness.waitForTask(next.id, context);
  });

  it("the parent never receives its child's result", async () => {
    const { faux, harness } = await fresh();
    const answer = route(turn("the parent ends here"), {
      "task for a": turn("CHILD-ANSWER-BENEATH-THE-SURFACE"),
    });
    faux.setResponses([turn("parent answer", ["a"]), answer, answer, turn("summed")]);

    const parent = await started(harness, "kick off");
    const child = children(await cascade(harness))[0];
    const next = await waitForSuccessor(harness, [child.id]);

    const transcript = await entries(harness, parent);
    expect(JSON.stringify(transcript)).not.toContain("CHILD-ANSWER-BENEATH-THE-SURFACE");
    // The successor gets only the lineage, never the words that crossed before it.
    const successorTranscript = await entries(harness, await conversationOf(harness, next.id));
    const text = JSON.stringify(successorTranscript);
    expect(text).not.toContain("the parent ends here");
    expect(text).not.toContain("CHILD-ANSWER-BENEATH-THE-SURFACE");
    expect(text).toContain(`conversation #${parent}`);
    expect(text).toContain(`conversation #${await conversationOf(harness, child.id)}`);
    await harness.waitForTask(next.id, context);
  });

  it("a successor is a new conversation, not the parent resumed", async () => {
    const { faux, harness } = await fresh();
    const answer = route(turn("a is on its way"), { "task for a": turn("a answers") });
    faux.setResponses([turn("I forked a.", ["a"]), answer, answer, turn("summed")]);

    const parent = await started(harness, "kick off");
    const next = await waitForSuccessor(harness);
    await harness.waitForTask(next.id, context);

    expect(await conversationOf(harness, next.id)).not.toBe(parent);
    const transcript = await entries(harness, parent);
    const author = transcript.flatMap((entry) => entry.model?.map((message) => message.role));
    expect(author.filter((role) => role === "user")).toHaveLength(1);
  });

  it("a run that forks nothing ends the cascade", async () => {
    const { faux, harness } = await fresh();
    faux.setResponses([turn("just an answer")]);

    await started(harness, "kick off");

    expect(await cascade(harness)).toEqual([]);
  });

  it("a child cannot fork", async () => {
    const { faux, harness } = await fresh();
    const childAnswer: FauxResponseStep = (request) =>
      request.messages.at(-1)?.role === "toolResult"
        ? turn("a cannot fork")
        : turn("a forks b", ["b"]);
    const answer = route(turn("a is on its way"), { "task for a": childAnswer });
    faux.setResponses([turn("I forked a.", ["a"]), answer, answer, answer, turn("summed")]);

    await started(harness, "kick off");
    const next = await waitForSuccessor(harness);
    await harness.waitForTask(next.id, context);

    expect(children(await cascade(harness)).map(nameOf)).toEqual(["a"]);
  });
});

describe("fork results", () => {
  it("a fork call whose result is an error starts nothing", async () => {
    const { faux, harness } = await fresh();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("fork", { name: "Not Kebab", prompt: "no" }), {
        stopReason: "toolUse",
      }),
      turn("no"),
    ]);

    await started(harness, "kick off");

    expect(await cascade(harness)).toEqual([]);
  });
});

describe("ask", () => {
  it("answers from a frozen conversation and leaves it untouched", async () => {
    const { faux, harness } = await fresh();
    const seen: string[] = [];
    let target: ConversationId | undefined;
    const step: FauxResponseStep = (request) => {
      const text = requestText(request.messages);
      const raw = JSON.stringify(request.messages);
      seen.push(raw);
      if (text.includes("task for a")) return turn("a answers");
      if (text.includes("Successor of conversation")) {
        if (raw.includes("ANSWER-FROM-FROZEN")) return turn("successor done");
        if (target === undefined) throw new Error("ask target not set");
        return fauxAssistantMessage(
          fauxToolCall("ask", { conversation: target, question: "WHY-ASK" }),
          { stopReason: "toolUse" },
        );
      }
      if (text.includes("WHY-ASK")) return fauxAssistantMessage("ANSWER-FROM-FROZEN");
      return request.messages.at(-1)?.role === "toolResult"
        ? turn("parent final")
        : turn("parent final", ["a"]);
    };
    faux.setResponses(Array.from({ length: 8 }, () => step));

    const handle = await conversation(harness);
    const parent = handle.id;
    target = parent;
    const submission = await handle.submit({ type: "input", content: "kick off" }, context);
    harness.resume();
    expect((await submission.wait(context)).status).toBe("done");
    const before = await entries(harness, parent);

    const next = await waitForSuccessor(harness);
    await harness.waitForTask(next.id, context);

    // The ask read the predecessor's own context, including its answer, and appended nothing there.
    const asked = seen.find(
      (text) => text.includes("WHY-ASK") && !text.includes("Successor of conversation"),
    );
    expect(asked).toContain("kick off");
    expect(asked).toContain("parent final");
    expect(await entries(harness, parent)).toEqual(before);

    // Only the lineage reached the successor.
    const successor = JSON.stringify(
      await entries(harness, await conversationOf(harness, next.id)),
    );
    expect(successor).not.toContain("parent final");
    expect(successor).toContain(`conversation #${parent}`);
  });
});

describe("a continuation", () => {
  it("messages a conversation in place and joins only that run's forks", async () => {
    const { faux, harness } = await fresh();
    const firstAnswer = route(turn("a is on its way"), { "task for a": turn("a answers") });
    faux.setResponses([turn("I forked a.", ["a"]), firstAnswer, firstAnswer, turn("summed")]);

    const kickoff = await started(harness, "kick off");
    await harness.waitForTask((await waitForSuccessor(harness)).id, context);

    const secondAnswer = route(turn("b is on its way"), { "task for b": turn("b answers") });
    faux.setResponses([turn("more work", ["b"]), secondAnswer, secondAnswer, turn("summed again")]);
    const handle = await harness.conversation(kickoff, context);
    if (handle === undefined) throw new Error(`no conversation #${kickoff}`);
    const submission = await handle.submit(
      { type: "input", content: "more work", whenBusy: "steer" },
      context,
    );
    expect((await submission.wait(context)).status).toBe("done");
    const b = children(await cascade(harness)).find((record) => nameOf(record) === "b");
    if (b === undefined) throw new Error("no fork b");
    const next = await waitForSuccessor(harness, [b.id]);
    await harness.waitForTask(next.id, context);

    const transcript = await entries(harness, kickoff);
    expect(transcript.filter((entry) => entry.kind === "pi.user")).toHaveLength(2);
    expect(children(await cascade(harness)).map(nameOf)).toEqual(["a", "b"]);
    expect(next.input).toEqual({ kind: "successor", on: [b.id] });
  });
});

describe("an interruption", () => {
  it("does not cancel a fork that already started or create a successor", async () => {
    const { faux, harness } = await fresh();
    const stuck = unanswered();
    const answer = route(stuck.step, { "task for a": turn("a answers") });
    faux.setResponses([turn("I forked a.", ["a"]), answer, answer]);

    const kickoff = await run(harness, "kick off");
    await stuck.reached;
    const child = children(await cascade(harness))[0];
    expect(child.input).toEqual({ kind: "fork", prompt: "task for a", name: "a" });
    await harness.waitForTask(child.id, context);

    const handle = await harness.conversation(kickoff, context);
    if (handle === undefined) throw new Error(`no conversation #${kickoff}`);
    await handle.abort(context);

    const records = await cascade(harness);
    expect(records.find((record) => record.id === child.id)?.state.outcome).toEqual({
      status: "completed",
      result: "a answers",
    });
    expect(successor(records)).toBeUndefined();
  });

  it("interrupts one child only: its successor settles and runs", async () => {
    const { faux, harness } = await fresh();
    const stuck = unanswered();
    const answer = route(turn("a is on its way"), { "task for a": stuck.step });
    faux.setResponses([turn("I forked a.", ["a"]), answer, answer, turn("summed")]);

    await started(harness, "kick off");
    const next = await waitForSuccessor(harness);
    const child = children(await cascade(harness))[0];
    await stuck.reached;
    await interrupt(harness, child.id);
    await harness.waitForTask(next.id, context);

    const records = await cascade(harness);
    expect(records.find((record) => record.id === child.id)?.state.outcome).toEqual({
      status: "aborted",
    });
    const transcript = await entries(harness, await conversationOf(harness, next.id));
    expect(JSON.stringify(transcript)).toContain(
      `agent/a: conversation #${await conversationOf(harness, child.id)}`,
    );
  });

  it("a message after an interrupt joins only its own forks", async () => {
    const { faux, harness } = await fresh();
    const stuck = unanswered();
    const firstAnswer = route(stuck.step, { "task for a": turn("a answers") });
    faux.setResponses([turn("I forked a.", ["a"]), firstAnswer, firstAnswer]);

    const kickoff = await run(harness, "kick off");
    await stuck.reached;
    const handle = await harness.conversation(kickoff, context);
    if (handle === undefined) throw new Error(`no conversation #${kickoff}`);
    await handle.abort(context);
    const a = children(await cascade(harness))[0];
    await harness.waitForTask(a.id, context);

    const secondAnswer = route(turn("wrapped up"), { "task for b": turn("b answers") });
    faux.setResponses([turn("I forked b.", ["b"]), secondAnswer, secondAnswer, turn("summed")]);
    const submission = await handle.submit(
      { type: "input", content: "wrap it up", whenBusy: "steer" },
      context,
    );
    expect((await submission.wait(context)).status).toBe("done");
    const records = await cascade(harness);
    const b = children(records).find((record) => nameOf(record) === "b");
    if (b === undefined) throw new Error("no fork b");
    const next = await waitForSuccessor(harness, [b.id]);
    await harness.waitForTask(next.id, context);

    expect(children(await cascade(harness)).map(nameOf)).toEqual(["a", "b"]);
    expect(next.input).toEqual({ kind: "successor", on: [b.id] });
  });
});
