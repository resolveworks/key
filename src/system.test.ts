import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxProviderHandle } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { configure, type Harness, MemoryStorage, type TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REPO } from "../tests/git.ts";
import {
  cascade,
  conversationOf,
  entries,
  type KeyRecord,
  KeyTask,
  keySetup,
  MODEL,
  openKey,
} from "../tests/harness.ts";

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

const children = (records: readonly KeyRecord[]) => records.filter((r) => "name" in r.input);
const nameOf = (record: KeyRecord): string | undefined =>
  "name" in record.input ? record.input.name : undefined;
const onOf = (record: KeyRecord): readonly TaskId<string>[] | undefined =>
  "on" in record.input ? record.input.on : undefined;

/** The fresh context a forking context mints: it waits on the children that context forked. */
function successor(records: readonly KeyRecord[]): KeyRecord | undefined {
  const ids = children(records).map((child) => child.id);
  return records.find((record) => {
    const on = onOf(record);
    return (
      !("name" in record.input) &&
      on !== undefined &&
      on.length > 0 &&
      on.every((id) => ids.includes(id))
    );
  });
}

/** Start one context, as the host does for a fresh prompt: one commit, one conversation, one task. */
async function run(harness: Harness, prompt: string): Promise<TaskId<string>> {
  const id = await harness.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, conversation.id, { model: MODEL, cwd: REPO });
    return tx.createTask(
      KeyTask,
      { prompt },
      { ownership: { kind: "conversation" }, conversationId: conversation.id },
    );
  }, context);
  harness.resume();
  return id;
}

/** Run one context to completion and return its task ID. */
async function started(harness: Harness, prompt: string): Promise<TaskId<string>> {
  const id = await run(harness, prompt);
  await harness.waitForTask(id, context);
  return id;
}

/** Wait until a forking context has minted its successor. */
async function waitForSuccessor(harness: Harness): Promise<KeyRecord> {
  let next: KeyRecord | undefined;
  await vi.waitFor(
    async () => {
      next = successor(await cascade(harness));
      expect(next).toBeDefined();
    },
    { interval: 5 },
  );
  return next as KeyRecord;
}

describe("the fork cascade", () => {
  it("one fork call mints one child and a fresh successor", async () => {
    const { faux, harness } = await fresh();
    // The second answer is the round after the fork: it is the text the successor inherits.
    faux.setResponses([turn("I forked a.", ["a"]), turn("a is on its way")]);

    await started(harness, "kick off");
    const next = await waitForSuccessor(harness);
    const child = children(await cascade(harness))[0];

    expect(child.input).toEqual({ prompt: "task for a", name: "a" });
    expect(next.input).toEqual({ prompt: "a is on its way", on: [child.id] });
  });

  it("several fork calls in a turn mint several children", async () => {
    const { faux, harness } = await fresh();
    faux.setResponses([turn("I forked a and b.", ["a", "b"]), turn("both are underway")]);

    await started(harness, "kick off");
    const next = await waitForSuccessor(harness);
    const forked = children(await cascade(harness)).sort((left, right) => left.id - right.id);

    expect(forked.map(nameOf)).toEqual(["a", "b"]);
    expect(onOf(next)).toEqual(forked.map((record) => record.id));
  });

  it("the parent never receives its child's result", async () => {
    const { faux, harness } = await fresh();
    faux.setResponses([
      turn("parent answer", ["a"]),
      turn("the parent ends here"),
      turn("CHILD-ANSWER-BENEATH-THE-SURFACE"),
    ]);

    const parent = await started(harness, "kick off");
    const next = await waitForSuccessor(harness);
    const record = (await cascade(harness)).find((task) => task.id === parent);

    expect(record?.state.outcome).toEqual({
      status: "completed",
      result: "the parent ends here",
    });
    const transcript = await entries(harness, await conversationOf(harness, parent));
    expect(JSON.stringify(transcript)).not.toContain("CHILD-ANSWER-BENEATH-THE-SURFACE");
    // It crosses only into the successor, as an upstream result.
    expect(next.input.prompt).toBe("the parent ends here");
  });

  it("a successor is a new context, not the parent resumed", async () => {
    const { faux, harness } = await fresh();
    faux.setResponses([turn("I forked a.", ["a"]), turn("a is on its way"), turn("a answers")]);

    const parent = await started(harness, "kick off");
    const next = await waitForSuccessor(harness);
    await harness.waitForTask(next.id, context);

    const parentConversation = await conversationOf(harness, parent);
    expect(await conversationOf(harness, next.id)).not.toBe(parentConversation);
    // The parent's conversation ends where the parent did: the successor never writes there.
    const transcript = await entries(harness, parentConversation);
    const author = transcript.flatMap((entry) => entry.model?.map((message) => message.role));
    expect(author.filter((role) => role === "user")).toHaveLength(1);
  });

  it("a context that forks nothing ends the cascade", async () => {
    const { faux, harness } = await fresh();
    faux.setResponses([turn("just an answer")]);

    const parent = await started(harness, "kick off");
    const records = await cascade(harness);

    expect(records.find((record) => record.id === parent)?.state.outcome).toEqual({
      status: "completed",
      result: "just an answer",
    });
    expect(children(records)).toEqual([]);
  });

  it("a child cannot fork", async () => {
    const { faux, harness } = await fresh();
    // The child's conversation has fork removed, so its call is refused and mints nothing.
    faux.setResponses([turn("I forked a.", ["a"]), turn("a is on its way")]);
    const kickoff = await run(harness, "kick off");
    // The parent asked twice; the child's request is next. Answer the child once, then it is refused.
    await vi.waitFor(() => expect(faux.state.callCount).toBeGreaterThanOrEqual(2), { interval: 5 });
    faux.setResponses([turn("a forks b", ["b"])]);
    await harness.waitForTask(kickoff, context);

    expect(children(await cascade(harness)).map(nameOf)).toEqual(["a"]);
  });
});

describe("what a context scans for forks", () => {
  it("a fork call whose result is an error mints nothing", async () => {
    const { faux, harness } = await fresh();
    faux.setResponses([
      turn("I forked a.", ["a"]),
      turn("a is on its way"),
      // The successor's turn contains the attempt; the scan considers every assistant message of a run.
      fauxAssistantMessage(
        [fauxToolCall("fork", { name: "b", prompt: "task for b" }), fauxText("no")],
        { stopReason: "toolUse" },
      ),
      turn("done"),
    ]);

    await started(harness, "kick off");
    const next = await waitForSuccessor(harness);
    await harness.waitForTask(next.id, context);

    // b was refused, so the only child is a.
    expect(children(await cascade(harness)).map(nameOf)).toEqual(["a"]);
  });
});

describe("a continuation", () => {
  it("messages a closed conversation in place and mints only the forks that run made", async () => {
    const { faux, harness } = await fresh();
    // Kickoff forks a and ends; the child and its heir drain; then the message runs and forks b.
    faux.setResponses([
      turn("I forked a.", ["a"]),
      turn("a is on its way"),
      turn("a answers"),
      turn("summed"),
      turn("more work", ["b"]),
      turn("b is on its way"),
      turn("b answers"),
      turn("summed again"),
    ]);

    const kickoff = await started(harness, "kick off");
    await harness.waitForTask((await waitForSuccessor(harness)).id, context);
    const conversation = await conversationOf(harness, kickoff);
    // Message it as the host does: one continuation context in the conversation it names.
    const continuation = await harness.commit(
      (tx) =>
        tx.createTask(
          KeyTask,
          { prompt: "more work", conversationId: conversation },
          { ownership: { kind: "conversation" }, conversationId: conversation },
        ),
      context,
    );
    harness.resume();
    await harness.waitForTask(continuation, context);

    // The message ran in the closed conversation itself, not a fresh one of its own.
    const transcript = await entries(harness, conversation);
    expect(transcript.filter((entry) => entry.kind === "pi.user")).toHaveLength(2);
    // Its forks minted at its terminus — and only its own: kickoff's child is not minted twice.
    const records = await cascade(harness);
    expect(children(records).map(nameOf)).toEqual(["a", "b"]);
    const b = children(records).find((record) => nameOf(record) === "b");
    expect(
      records.find((record) => !("name" in record.input) && onOf(record)?.[0] === b?.id)?.input,
    ).toEqual({ prompt: "b is on its way", on: [b?.id] });
    expect(
      records.find((record) => record.id === continuation)?.state.outcome,
    ).toEqual({ status: "completed", result: "b is on its way" });
  });
});
