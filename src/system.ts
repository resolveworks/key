import { clampThinkingLevel, contentText, type Models, Type } from "@earendil-works/pi-ai";
import {
  type ConversationHandle,
  type ConversationId,
  type Cursor,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type EntryRecord,
  GenerationTask,
  hook,
  runEndTask,
  section,
  type TaskId,
  type TaskRuntime,
  ToolResultEntry,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Git } from "./git.ts";
import { ModelDefaultsDoc } from "./models.ts";
import { DEFAULT_THINKING_LEVEL, ThinkingDefaultsDoc } from "./thinking.ts";
import { branchFor, CHILD_NAME, ensureWorktree } from "./worktree.ts";

/** A fork or the successor of a run: a task in a fresh conversation. */
export type KeyTaskInput =
  | {
      readonly kind: "fork";
      readonly prompt: string;
      /** The fork's worktree and branch name; forks cannot fork again. */
      readonly name: string;
    }
  | {
      readonly kind: "successor";
      /** The fork tasks whose conversations the successor frames, then queries through ask. */
      readonly on: readonly TaskId<string>[];
    };

type KeyTaskState =
  | { readonly phase: "wait" }
  | { readonly phase: "run"; readonly conversationId?: ConversationId };

/** A fork or successor submits one prompt to its fresh conversation and returns the final text. */
export const KeyTask = defineTask<KeyTaskInput, KeyTaskState, string>({
  name: "key.run",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (record, runtime, context) => {
      if (record.input.kind === "successor") {
        const on = record.input.on;
        await runtime.commit(
          () => ({
            status: "waiting",
            on,
            policy: "allSettled",
            checkpoint: { phase: "run" },
          }),
          context,
        );
        return;
      }
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "run" } }), context);
    },
    run: async (record, runtime, context) => {
      let conversationId = record.state.checkpoint.conversationId;
      if (conversationId === undefined) {
        await runtime.commit(async (tx) => {
          conversationId =
            (await tx.scanConversations({ ownerTaskId: record.id }, 1)).items[0]?.id ??
            (await tx.createConversation({ ownership: { kind: "task", taskId: record.id } })).id;
          return { status: "running", checkpoint: { phase: "run", conversationId } };
        }, context);
      }
      if (conversationId === undefined) throw new Error(`key.run ${record.id}: no conversation`);
      const handle = await runtime.conversation(conversationId, context);
      if (handle === undefined)
        throw new Error(`key.run ${record.id}: conversation ${conversationId} is gone`);

      const text =
        record.input.kind === "fork"
          ? record.input.prompt
          : await successorPrompt(record.input, record.conversationId, runtime, context);
      const result = await answerOfRun(handle, runtime, context, `key.run:${record.id}`, text);
      if (result === undefined) {
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "aborted" } }),
          context,
        );
        return;
      }
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result } }),
        context,
      );
    },
  },
  abort: async (_record, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

function answerOf(entry: EntryRecord | undefined): string {
  const message = entry?.model?.[0];
  if (message?.role !== "assistant") throw new Error("answer has no assistant message");
  return contentText(message.content, "");
}

/** Submit one prompt to a conversation and return its answer; `undefined` when the run aborted. */
async function answerOfRun<I, S extends { phase: string }, R, H extends object>(
  handle: ConversationHandle,
  runtime: TaskRuntime<I, S, R, H>,
  context: Parameters<TaskRuntime<I, S, R, H>["context"]>[1],
  key: string,
  text: string,
): Promise<string | undefined> {
  const submission = await handle.submit(
    { type: "input", content: text, requestId: key, whenBusy: "steer" },
    context,
  );
  const settled = await submission.wait(context);
  if (settled.status === "unanswered" && settled.reason === "aborted") return undefined;
  if (settled.status !== "done" || settled.type !== "input") {
    throw new Error(
      `${key}: run ended ${settled.status}` +
        (settled.status === "unanswered" ? `: ${settled.reason}` : ""),
    );
  }
  return answerOf(
    (await runtime.context(handle.id, context)).entries.find(
      (entry) => entry.id === settled.answer,
    ),
  );
}

/** The successor's opening: only what it can gather from — each fork's branch, and the
 * conversations behind ask. Their words stay behind ask. */
async function successorPrompt(
  input: Extract<KeyTaskInput, { readonly kind: "successor" }>,
  predecessor: ConversationId,
  runtime: Parameters<typeof KeyTask.definition.phases.run>[1],
  context: Parameters<typeof KeyTask.definition.phases.run>[2],
): Promise<string> {
  const forks: { readonly branch: string; readonly conversation: ConversationId }[] = [];
  await runtime.commit(async (tx) => {
    // `on` holds only forks the predecessor's own run minted, task and conversation in one commit.
    for (const task of input.on) {
      const fork = (await tx.task(task))?.input as Extract<KeyTaskInput, { kind: "fork" }>;
      const conversation = (await tx.scanConversations({ ownerTaskId: task }, 1)).items[0];
      forks.push({ branch: branchFor(fork.name), conversation: conversation.id });
    }
    return undefined;
  }, context);
  return [
    `Successor of conversation #${predecessor}.`,
    "",
    "Forks before you, their work on their branches — ask any conversation above:",
    ...forks.map(({ branch, conversation }) => `- ${branch}: conversation #${conversation}`),
  ].join("\n");
}

/** A successor mints no conversation here — its wait ends first, and the conversation it runs
 * in is minted when the wait does. */
async function createRun(tx: Tx, input: KeyTaskInput): Promise<TaskId<string>> {
  return tx.createTask(KeyTask, input, {
    ownership: { kind: "conversation" },
    background: true,
  });
}

/** The successor a completed run requests: the forks it joins. */
type SpawnInput = { readonly on: TaskId<string>[] };

/** The successor's task, without keeping the completed run busy with it: the heir lists newer
 * than every fork it joins. */
const SpawnTask = defineTask<SpawnInput, { readonly phase: "spawn" }, null>({
  name: "key.spawn",
  version: 1,
  initial: () => ({ phase: "spawn" }),
  phases: {
    spawn: async (record, runtime, context) => {
      await runtime.commit(async (tx) => {
        await createRun(tx, { kind: "successor", on: record.input.on });
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context);
    },
  },
  abort: async (_record, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

/** A replay of one tool call reattaches to the fork its first attempt created. */
const ForkCreation = defineDoc<{ taskId?: TaskId<string> }>({
  kind: "key.fork",
  version: 1,
  scope: "task",
  initial: () => ({}),
  checkpointWhen: () => false,
});

const forkTool = (git: Git, models: () => Models) => {
  const Fork = defineTool({
    name: "fork",
    description:
      "Start one child task immediately in its own git worktree and conversation. You do not wait for it. Call fork once per child; calling it several times forks several children. When your run answers, a fresh successor starts once all its children settle, with each child's branch and conversation. It queries them through ask. A child does not fork.",
    parameters: Type.Object({
      name: Type.String({
        pattern: CHILD_NAME.source,
        description: "Lowercase kebab-case child name.",
      }),
      prompt: Type.String({ description: "The prompt for the child task." }),
    }),
    replay: "safe",
    execute: async ({ prompt, name }, call, context) => {
      const repo = (await call.agent(context)).cwd;
      if (repo === undefined) throw new Error("fork: no cwd to make a worktree from");
      const worktree = await ensureWorktree(name, git, repo);
      const taskId = await call.commit(async (tx) => {
        const creation = await tx.doc(ForkCreation, call.taskId);
        if (creation.taskId !== undefined) return creation.taskId;
        const task = await createRun(tx, { kind: "fork", prompt, name });
        const conversation = await tx.createConversation({
          ownership: { kind: "task", taskId: task },
        });
        // The fork starts on the child default, clamped to it; a successor keeps the agent copy
        // its creation took of the conversation it continues.
        const child = (await tx.doc(ModelDefaultsDoc)).child;
        if (child === undefined)
          throw new Error("fork: no child model default: set one with /model");
        const model = models().getModel(child.provider, child.modelId);
        if (model === undefined)
          throw new Error(`fork: unknown model ${child.provider}/${child.modelId}`);
        const level = (await tx.doc(ThinkingDefaultsDoc)).child ?? DEFAULT_THINKING_LEVEL;
        await configure(tx, conversation.id, {
          cwd: worktree.path,
          model: child,
          thinkingLevel: clampThinkingLevel(model, level),
          tools: { remove: [Fork, Ask] },
        });
        creation.taskId = task;
        return task;
      }, context);
      return {
        output: [{ type: "text", text: `Started fork task #${taskId}.` }],
        details: { taskId },
      };
    },
  });
  return Fork;
};

/** One question answered in a fork of a settled conversation; the original is never touched. */
type AskInput = {
  readonly conversation: ConversationId;
  readonly question: string;
};

type AskTaskState = { readonly phase: "ask"; readonly conversationId?: ConversationId };

const AskTask = defineTask<AskInput, AskTaskState, string>({
  name: "key.ask",
  version: 1,
  initial: () => ({ phase: "ask" }),
  phases: {
    ask: async (record, runtime, context) => {
      const { conversation, question } = record.input;
      let forkId = record.state.checkpoint.conversationId;
      if (forkId === undefined) {
        await runtime.commit(async (tx) => {
          // Replay-safe: a rerun after a crash reattaches to the fork its task owns.
          forkId = (await tx.scanConversations({ ownerTaskId: record.id }, 1)).items[0]?.id;
          if (forkId === undefined) {
            const at = await tx.latestEntryId(conversation);
            if (at === undefined)
              throw new Error(`key.ask ${record.id}: conversation #${conversation} is empty`);
            forkId = (
              await tx.forkConversation(conversation, at, {
                ownership: { kind: "task", taskId: record.id },
              })
            ).id;
          }
          return { status: "running", checkpoint: { phase: "ask", conversationId: forkId } };
        }, context);
      }
      if (forkId === undefined) throw new Error(`key.ask ${record.id}: no fork conversation`);
      const handle = await runtime.conversation(forkId, context);
      if (handle === undefined)
        throw new Error(`key.ask ${record.id}: fork conversation ${forkId} is gone`);

      // The fork carries the child's agent as of its last entry: same model, same tools, same
      // worktree — the request prefix is byte-identical, so the provider cache still hits.
      const answer = await answerOfRun(handle, runtime, context, `key.ask:${record.id}`, question);
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome:
            answer === undefined ? { status: "aborted" } : { status: "completed", result: answer },
        }),
        context,
      );
    },
  },
  abort: async (_record, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

/** A replay of one ask tool call reattaches to the question its first attempt started. */
const AskCall = defineDoc<{ taskId?: TaskId<string> }>({
  kind: "key.ask-call",
  version: 1,
  scope: "task",
  initial: () => ({}),
  checkpointWhen: () => false,
});

const Ask = defineTool({
  name: "ask",
  description:
    "Ask a settled conversation a question. It answers in a private fork of its own context, with its tools; the conversation itself is never modified. Batch compound questions into one ask; several asks may run in parallel.",
  parameters: Type.Object({
    conversation: Type.Number({ description: "The conversation id from the framing." }),
    question: Type.String({ description: "The question to answer from that conversation." }),
  }),
  replay: "safe",
  execute: async ({ conversation, question }, api, context) => {
    const task = await api.commit(async (tx) => {
      const call = await tx.doc(AskCall, api.taskId);
      if (call.taskId !== undefined) return call.taskId;
      call.taskId = await tx.createTask(
        AskTask,
        { conversation: conversation as ConversationId, question },
        { ownership: { kind: "task", taskId: api.taskId } },
      );
      return call.taskId;
    }, context);
    const settled = await api.waitForTask(task, context);
    if (settled.state.outcome.status !== "completed")
      throw new Error(`ask failed: ${settled.state.outcome.status}`);
    return { output: [{ type: "text", text: settled.state.outcome.result }] };
  },
});

/** The host's system: direct conversation runs, with tasks only at cascade boundaries. */
export const keySystem = (git: Git, models: () => Models) => {
  const Fork = forkTool(git, models);
  return {
    extension: defineExtension({
      name: "key",
      // Installed after the coding tools, so the framing renders ahead of project context. Untagged.
      sections: [
        section(
          "preamble",
          () =>
            "You are an expert coding assistant operating inside key, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
          { tag: false },
        ),
      ],
      hooks: [
        hook(GenerationTask, {
          afterRun: async (run, api, context) => {
            const on: TaskId<string>[] = [];
            let cursor: Cursor | undefined;
            do {
              const page = await api.entries(
                {
                  minEntryId: run.first,
                  maxEntryId: run.last,
                  order: "ascending",
                },
                256,
                cursor,
                context,
              );
              for (const entry of page.items) {
                if (!ToolResultEntry.is(entry)) continue;
                const message = entry.model?.[0];
                if (
                  message?.role !== "toolResult" ||
                  message.toolName !== "fork" ||
                  message.isError
                )
                  continue;
                const taskId = (message.details as { readonly taskId?: TaskId<string> } | undefined)
                  ?.taskId;
                if (taskId === undefined) throw new Error(`fork result ${entry.id} has no task ID`);
                on.push(taskId);
              }
              cursor = page.next;
            } while (cursor !== undefined);
            if (on.length === 0) return undefined;
            return { tasks: [runEndTask(SpawnTask, { on })] };
          },
        }),
      ],
      tasks: [KeyTask, SpawnTask, AskTask],
      tools: [Fork, Ask],
    }),
    task: KeyTask,
  };
};
