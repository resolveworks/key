import { type AssistantMessage, contentText, Type } from "@earendil-works/pi-ai";
import {
  AgentDoc,
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
  ProviderDoc,
  runEndTask,
  section,
  type TaskId,
  ToolResultEntry,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Git } from "./git.ts";
import { CHILD_NAME, ensureWorktree } from "./worktree.ts";

/** A fork or the successor of a run: a task in a fresh conversation. */
export type KeyTaskInput =
  | {
      readonly kind: "fork";
      readonly prompt: string;
      /** The fork's worktree and branch; forks cannot fork again. */
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
          : await successorPrompt(record.input, record.id, record.conversationId, runtime, context);
      const submission = await handle.submit(
        { type: "input", content: text, requestId: `key.run:${record.id}`, whenBusy: "steer" },
        context,
      );
      const settled = await submission.wait(context);
      if (settled.status === "unanswered" && settled.reason === "aborted") {
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "aborted" } }),
          context,
        );
        return;
      }
      if (settled.status !== "done" || settled.type !== "input") {
        throw new Error(
          `key.run ${record.id}: run ended ${settled.status}` +
            (settled.status === "unanswered" ? `: ${settled.reason}` : ""),
        );
      }
      const result = answerOf(
        (await runtime.context(conversationId, context)).entries.find(
          (entry) => entry.id === settled.answer,
        ),
      );
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

/** The successor's opening: only the conversations before it, named by id. Their words stay behind ask. */
async function successorPrompt(
  input: Extract<KeyTaskInput, { readonly kind: "successor" }>,
  taskId: number,
  predecessor: ConversationId,
  runtime: Parameters<typeof KeyTask.definition.phases.run>[1],
  context: Parameters<typeof KeyTask.definition.phases.run>[2],
): Promise<string> {
  const children: { readonly task: TaskId<string>; readonly conversation: ConversationId }[] = [];
  await runtime.commit(async (tx) => {
    for (const task of input.on) {
      const conversation = (await tx.scanConversations({ ownerTaskId: task }, 1)).items[0];
      if (conversation === undefined)
        throw new Error(`key.run ${taskId}: task #${task} owns no conversation`);
      children.push({ task, conversation: conversation.id });
    }
    return undefined;
  }, context);
  return [
    `Successor of conversation #${predecessor}.`,
    "",
    "Before you:",
    `- conversation #${predecessor}`,
    ...children.map(({ task, conversation }) => `- task #${task}: conversation #${conversation}`),
  ].join("\n");
}

/** Create one asynchronous branch and the conversation it owns, in the current conversation. */
/** Create a run's task; a successor mints no conversation here — its wait ends first, and the
 * conversation it runs in is minted when the wait does. */
async function createRun(tx: Tx, input: KeyTaskInput): Promise<TaskId<string>> {
  return tx.createTask(KeyTask, input, {
    ownership: { kind: "conversation" },
    background: true,
  });
}

/** The successor a completed run requests: the forks it joins. */
type SpawnInput = { readonly on: TaskId<string>[] };

/** Create the successor's task without keeping the completed run busy with it; the conversation
 * is minted when the successor's wait ends, so the heir lists newer than every fork it joins. */
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

const forkTool = (git: Git) => {
  const Fork = defineTool({
    name: "fork",
    description:
      "Start one child task immediately in its own git worktree and conversation. You do not wait for it. Call fork once per child; calling it several times forks several children. When your run answers, a fresh successor starts once all its children settle, with their conversation ids. It queries them through ask. A child does not fork.",
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
        await configure(tx, conversation.id, {
          cwd: worktree.path,
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

/** One question answered from a conversation's frozen context; the target is never appended to. */
type AskInput = {
  readonly conversation: ConversationId;
  readonly question: string;
};

type AskResult = {
  readonly text: string;
  readonly usage: AssistantMessage["usage"];
};

const AskTask = defineTask<AskInput, { readonly phase: "ask" }, AskResult>({
  name: "key.ask",
  version: 1,
  initial: () => ({ phase: "ask" }),
  phases: {
    ask: async (record, runtime, context) => {
      const { conversation, question } = record.input;
      const agent = await runtime.snapshot(AgentDoc, conversation, context);
      if (agent?.model === undefined)
        throw new Error(`key.ask ${record.id}: conversation #${conversation} has no model`);
      const ref = agent.model;
      const model = runtime.models.getModel(ref.provider, ref.modelId);
      if (model === undefined)
        throw new Error(`key.ask ${record.id}: unknown model ${ref.provider}/${ref.modelId}`);

      const view = await runtime.context(conversation, context);
      const provider = await runtime.snapshot(ProviderDoc, conversation, context);
      const answer = await runtime.models.completeSimple(
        model,
        {
          messages: [
            ...view.messages,
            { role: "user", content: question, timestamp: runtime.now() },
          ],
        },
        {
          signal: runtime.signal,
          telemetry: context.telemetry,
          ...(provider === undefined ? {} : { sessionId: provider.sessionId }),
          ...(agent.thinkingLevel === "off" ? {} : { reasoning: agent.thinkingLevel }),
        },
      );
      runtime.signal.throwIfAborted();
      if (answer.stopReason === "error")
        throw new Error(`key.ask ${record.id}: ${answer.errorMessage ?? "model error"}`);

      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: {
            status: "completed",
            result: { text: contentText(answer.content, ""), usage: answer.usage },
          },
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
const AskCall = defineDoc<{ taskId?: TaskId<AskResult> }>({
  kind: "key.ask-call",
  version: 1,
  scope: "task",
  initial: () => ({}),
  checkpointWhen: () => false,
});

const Ask = defineTool({
  name: "ask",
  description:
    "Ask a settled conversation a question. The answer comes from that conversation's own frozen context; the conversation is never modified. Batch compound questions into one ask; several asks may run in parallel.",
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
    return {
      output: [{ type: "text", text: settled.state.outcome.result.text }],
      usage: settled.state.outcome.result.usage,
    };
  },
});

/** The host's system: direct conversation runs, with tasks only at cascade boundaries. */
export const keySystem = (git: Git) => {
  const Fork = forkTool(git);
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
