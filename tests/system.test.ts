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
import { workerBranch } from "../src/worker.ts";
import { gitCalls, REPO, resetGit, setGitDiff } from "./git.ts";
import {
  type ConversationTaskRecord,
  cascade,
  conversationOf,
  entries,
  interrupt,
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

/** One answer: the children it calls, then the text its turn ends with. */
function turn(text: string, children: readonly string[] = []) {
  return fauxAssistantMessage(
    [
      ...children.map((name) => fauxToolCall("delegate", { name, prompt: `task for ${name}` })),
      fauxText(text),
    ],
    { stopReason: children.length === 0 ? "stop" : "toolUse" },
  );
}

const children = (records: readonly ConversationTaskRecord[]) =>
  records.filter((record) => record.input.kind !== "successor");
const branchOf = (record: ConversationTaskRecord): string | undefined =>
  record.input.kind === "worker" ? workerBranch(record.input.name) : undefined;
const onOf = (record: ConversationTaskRecord): readonly TaskId<string>[] | undefined =>
  record.input.kind === "successor" ? record.input.on : undefined;

function successor(
  records: readonly ConversationTaskRecord[],
  on?: readonly TaskId<string>[],
): ConversationTaskRecord | undefined {
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
): Promise<ConversationTaskRecord> {
  let next: ConversationTaskRecord | undefined;
  await vi.waitFor(
    async () => {
      next = successor(await cascade(harness), on);
      expect(next).toBeDefined();
    },
    { interval: 5 },
  );
  return next as ConversationTaskRecord;
}

describe("the child cascade", () => {
  it("one delegation starts one worker immediately and then a fresh successor", async () => {
    const { faux, harness } = await fresh();
    const answer = route(turn("a is on its way"), { "task for a": turn("a answers") });
    faux.setResponses([turn("I delegated a.", ["a"]), answer, answer, turn("summed")]);

    await started(harness, "kick off");
    const child = children(await cascade(harness))[0];
    const next = await waitForSuccessor(harness, [child.id]);

    expect(child.input).toEqual({ kind: "worker", name: "a", prompt: "task for a" });
    expect(next.input).toEqual({ kind: "successor", on: [child.id] });
    await harness.waitForTask(next.id, context);
  });

  it("several delegations start several workers", async () => {
    const { faux, harness } = await fresh();
    const answer = route(turn("both are underway"), {
      "task for a": turn("a answers"),
      "task for b": turn("b answers"),
    });
    faux.setResponses([
      turn("I delegated a and b.", ["a", "b"]),
      answer,
      answer,
      answer,
      turn("summed"),
    ]);

    await started(harness, "kick off");
    const delegated = children(await cascade(harness)).sort((left, right) => left.id - right.id);
    const next = await waitForSuccessor(harness);

    expect(delegated.map(branchOf)).toEqual(["worker/a", "worker/b"]);
    expect([...(onOf(next) ?? [])].sort()).toEqual(delegated.map((record) => record.id).sort());
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
    const text = JSON.stringify(await entries(harness, await conversationOf(harness, next.id)));
    expect(text).toContain("CHILD-ANSWER-BENEATH-THE-SURFACE");
    expect(text).toContain(`conversation #${parent}`);
    expect(text).toContain(`conversation=\\"${await conversationOf(harness, child.id)}\\"`);
    await harness.waitForTask(next.id, context);
  });

  it("gives a successor a worker's diff instead of its final message", async () => {
    const { faux, harness } = await fresh();
    resetGit();
    setGitDiff("diff --git a/auth.ts b/auth.ts\n+fixed");
    const answer = route(turn("a is on its way"), { "task for a": turn("worker summary") });
    faux.setResponses([turn("I delegated a.", ["a"]), answer, answer, turn("summed")]);

    await started(harness, "kick off");
    const next = await waitForSuccessor(harness);
    const transcript = JSON.stringify(
      await entries(harness, await conversationOf(harness, next.id)),
    );

    expect(transcript).toContain("diff --git a/auth.ts b/auth.ts");
    expect(transcript).not.toContain("worker summary");
    expect(gitCalls()).toContainEqual(["diff", "HEAD...worker/a"]);
    await harness.waitForTask(next.id, context);
  });

  it("starts a researcher without a worktree and gives its answer to the successor", async () => {
    const { faux, harness } = await fresh();
    resetGit();
    const step: FauxResponseStep = (request) => {
      const text = requestText(request.messages);
      if (text.includes("investigate auth")) return turn("RESEARCH-FINDINGS");
      if (text.includes("Successor of conversation")) return turn("summed");
      if (request.messages.at(-1)?.role === "toolResult") return turn("research started");
      return fauxAssistantMessage(fauxToolCall("research", { prompt: "investigate auth" }), {
        stopReason: "toolUse",
      });
    };
    faux.setResponses([step, step, step, step]);

    await started(harness, "kick off");
    const child = children(await cascade(harness))[0];
    const next = await waitForSuccessor(harness, [child.id]);
    const transcript = JSON.stringify(
      await entries(harness, await conversationOf(harness, next.id)),
    );

    expect(child.input).toEqual({ kind: "researcher", prompt: "investigate auth" });
    expect(transcript).toContain("RESEARCH-FINDINGS");
    expect(gitCalls()).toEqual([]);
    await harness.waitForTask(next.id, context);
  });

  it("a successor does not resume the parent conversation", async () => {
    const { faux, harness } = await fresh();
    const answer = route(turn("a is on its way"), { "task for a": turn("a answers") });
    faux.setResponses([turn("I delegated a.", ["a"]), answer, answer, turn("summed")]);

    const parent = await started(harness, "kick off");
    const next = await waitForSuccessor(harness);
    await harness.waitForTask(next.id, context);

    const transcript = await entries(harness, parent);
    const roles = transcript.flatMap((entry) => entry.model?.map((message) => message.role));
    expect(roles.filter((role) => role === "user")).toHaveLength(1);
  });

  it("a run that starts no children ends the cascade", async () => {
    const { faux, harness } = await fresh();
    faux.setResponses([turn("just an answer")]);

    const parent = await started(harness, "kick off");
    // The run's end task could still mint a successor: wait until the conversation has nothing left.
    const handle = await harness.conversation(parent, context);
    if (handle === undefined) throw new Error(`no conversation #${parent}`);
    await handle.waitForIdle(context);

    expect(await cascade(harness)).toEqual([]);
  });

  it("a child cannot start children", async () => {
    const { faux, harness } = await fresh();
    const childAnswer: FauxResponseStep = (request) =>
      request.messages.at(-1)?.role === "toolResult"
        ? turn("a cannot delegate")
        : turn("a delegates b", ["b"]);
    const answer = route(turn("a is on its way"), { "task for a": childAnswer });
    faux.setResponses([turn("I delegated a.", ["a"]), answer, answer, answer, turn("summed")]);

    await started(harness, "kick off");
    const next = await waitForSuccessor(harness);
    await harness.waitForTask(next.id, context);

    expect(children(await cascade(harness)).map(branchOf)).toEqual(["worker/a"]);
  });
});

describe("child results", () => {
  it("a delegation that fails its schema starts no child", async () => {
    const { faux, harness } = await fresh();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("delegate", { name: "Not Kebab", prompt: "no" }), {
        stopReason: "toolUse",
      }),
      // A worker wrongly started by this call would need a third answer, so the failure stays here.
      turn("no"),
      turn("no"),
    ]);

    const parent = await started(harness, "kick off");
    const rejected = (await entries(harness, parent)).filter(
      (entry) => entry.kind === "pi.tool-result",
    );

    expect(JSON.stringify(rejected)).toContain("expected to match ^[a-z0-9]+(?:-[a-z0-9]+)*$");
    expect(children(await cascade(harness))).toEqual([]);
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

  it("answers in one fork and leaves the target conversation untouched", async () => {
    const { faux, harness } = await fresh();
    const target = await conversation(harness);
    const ask: FauxResponseStep = (request) => {
      const text = requestText(request.messages);
      if (text.includes("WHY-ASK")) return turn("ANSWER-FROM-FROZEN");
      if (text.includes("background context")) return turn("target answer");
      return request.messages.at(-1)?.role === "toolResult"
        ? turn("asked and answered")
        : fauxAssistantMessage(
            fauxToolCall("ask", { conversation: target.id, question: "WHY-ASK" }),
            { stopReason: "toolUse" },
          );
    };
    faux.setResponses([ask, ask, ask, ask]);
    const settledTarget = await target.submit(
      { type: "input", content: "background context" },
      context,
    );
    harness.resume();
    expect((await settledTarget.wait(context)).status).toBe("done");
    const before = await entries(harness, target.id);

    const main = await conversation(harness);
    const asked = await main.submit({ type: "input", content: "kick off" }, context);
    expect((await asked.wait(context)).status).toBe("done");

    const forks = await harness.commit(async (tx) => {
      const { items } = await tx.scanConversations({}, 100);
      return items.filter((item) => item.parent?.conversationId === target.id);
    }, context);
    expect(forks).toHaveLength(1);
    expect(await entries(harness, target.id)).toEqual(before);
    expect(JSON.stringify(await entries(harness, main.id))).toContain("ANSWER-FROM-FROZEN");
  });
});

describe("a continuation", () => {
  it("a steer starts a second run in the same conversation and a second successor", async () => {
    const { faux, harness } = await fresh();
    const firstAnswer = route(turn("a is on its way"), { "task for a": turn("a answers") });
    faux.setResponses([turn("I delegated a.", ["a"]), firstAnswer, firstAnswer, turn("summed")]);

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
    const b = children(await cascade(harness)).find((record) => branchOf(record) === "worker/b");
    if (b === undefined) throw new Error("no child b");
    const next = await waitForSuccessor(harness, [b.id]);
    await harness.waitForTask(next.id, context);

    const transcript = await entries(harness, kickoff);
    expect(transcript.filter((entry) => entry.kind === "pi.user")).toHaveLength(2);
    expect(children(await cascade(harness)).map(branchOf)).toEqual(["worker/a", "worker/b"]);
  });
});

describe("an interruption", () => {
  it("does not cancel a child that already started or create a successor", async () => {
    const { faux, harness } = await fresh();
    const stuck = unanswered();
    const answer = route(stuck.step, { "task for a": turn("a answers") });
    faux.setResponses([turn("I delegated a.", ["a"]), answer, answer]);

    const kickoff = await run(harness, "kick off");
    await stuck.reached;
    const child = children(await cascade(harness))[0];
    expect(child.input).toEqual({ kind: "worker", name: "a", prompt: "task for a" });
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
    faux.setResponses([turn("I delegated a.", ["a"]), answer, answer, turn("summed")]);

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
      `<worker branch=\\"worker/a\\" conversation=\\"${await conversationOf(harness, child.id)}\\">`,
    );
  });

  it("a message after an interrupt joins only its own children", async () => {
    const { faux, harness } = await fresh();
    const stuck = unanswered();
    const firstAnswer = route(stuck.step, { "task for a": turn("a answers") });
    faux.setResponses([turn("I delegated a.", ["a"]), firstAnswer, firstAnswer]);

    const kickoff = await run(harness, "kick off");
    await stuck.reached;
    const handle = await harness.conversation(kickoff, context);
    if (handle === undefined) throw new Error(`no conversation #${kickoff}`);
    await handle.abort(context);
    const a = children(await cascade(harness))[0];
    await harness.waitForTask(a.id, context);

    const secondAnswer = route(turn("wrapped up"), { "task for b": turn("b answers") });
    faux.setResponses([turn("I delegated b.", ["b"]), secondAnswer, secondAnswer, turn("summed")]);
    const submission = await handle.submit(
      { type: "input", content: "wrap it up", whenBusy: "steer" },
      context,
    );
    expect((await submission.wait(context)).status).toBe("done");
    const records = await cascade(harness);
    const b = children(records).find((record) => branchOf(record) === "worker/b");
    if (b === undefined) throw new Error("no child b");
    const next = await waitForSuccessor(harness, [b.id]);
    await harness.waitForTask(next.id, context);

    expect(children(await cascade(harness)).map(branchOf)).toEqual(["worker/a", "worker/b"]);
    expect(next.input).toEqual({ kind: "successor", on: [b.id] });
  });
});
