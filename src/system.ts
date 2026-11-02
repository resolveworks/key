import { clampThinkingLevel, contentText, type Models, Type } from "@earendil-works/pi-ai";
import {
  AgentDoc,
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
  type TaskRecord,
  type TaskRuntime,
  ToolResultEntry,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Git } from "./git.ts";
import { ModelDefaultsDoc } from "./models.ts";
import { DEFAULT_THINKING_LEVEL, ThinkingDefaultsDoc } from "./thinking.ts";
import { ensureWorker, WORKER_NAME, workerBranch } from "./worker.ts";

export const CONVERSATION_INSTRUCTIONS =
  "Work directly on simple tasks. Delegate independent implementation work or start researchers for questions that benefit from an isolated context.";
export const WORKER_INSTRUCTIONS =
  "You are an expert coding assistant completing a delegated implementation task in your own git worktree and branch. Implement and test the requested changes, commit them, and report anything left undone.";
export const RESEARCHER_INSTRUCTIONS =
  "You are an expert research assistant answering a delegated question. Use the available tools to investigate and return self-contained findings, including relevant sources and uncertainties.";

/** A worker, researcher, or the successor of a run: a task in a fresh conversation. */
export type ConversationTaskInput =
  | {
      readonly kind: "worker";
      readonly name: string;
      readonly prompt: string;
      readonly base: string;
    }
  | { readonly kind: "researcher"; readonly prompt: string }
  | {
      readonly kind: "successor";
      /** The children whose results the successor receives. */
      readonly on: readonly TaskId<string>[];
    };

type ConversationTaskState =
  | { readonly phase: "wait" }
  | { readonly phase: "run"; readonly conversationId?: ConversationId };

/** A child or successor submits one prompt to its fresh conversation and returns the final text. */
export const CONVERSATION_TASK = "key.conversation";

export const conversationTask = (git: Git) =>
  defineTask<ConversationTaskInput, ConversationTaskState, string>({
    name: CONVERSATION_TASK,
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
        if (conversationId === undefined)
          throw new Error(`key.conversation ${record.id}: no conversation`);
        const handle = await runtime.conversation(conversationId, context);
        if (handle === undefined)
          throw new Error(`key.conversation ${record.id}: conversation ${conversationId} is gone`);

        const text =
          record.input.kind === "successor"
            ? await successorPrompt(
                record.input,
                record.conversationId,
                handle,
                git,
                runtime,
                context,
              )
            : record.input.prompt;
        const result = await answerOfRun(
          handle,
          runtime,
          context,
          `key.conversation:${record.id}`,
          text,
        );
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

type Child = {
  readonly input: Extract<ConversationTaskInput, { kind: "worker" | "researcher" }>;
  readonly conversation: ConversationId;
  readonly answer?: string;
  readonly status: string;
};

/** The successor's opening: each child's diff, or its answer when it made no diff. */
async function successorPrompt(
  input: Extract<ConversationTaskInput, { kind: "successor" }>,
  predecessor: ConversationId,
  successor: ConversationHandle,
  git: Git,
  runtime: TaskRuntime<ConversationTaskInput, ConversationTaskState, string, object>,
  context: Parameters<
    TaskRuntime<ConversationTaskInput, ConversationTaskState, string, object>["context"]
  >[1],
): Promise<string> {
  const children: Child[] = [];
  let cwd: string | undefined;
  await runtime.commit(async (tx) => {
    cwd = (await tx.doc(AgentDoc, successor.id)).cwd;
    for (const task of input.on) {
      const record = (await tx.task(task)) as
        | TaskRecord<ConversationTaskInput, ConversationTaskState, string>
        | undefined;
      if (record === undefined) throw new Error(`successor: no child task ${task}`);
      if (record.input.kind === "successor")
        throw new Error(`successor: child task ${task} is a successor`);
      const outcome = record.state.outcome;
      if (outcome === undefined) throw new Error(`successor: child task ${task} has no outcome`);
      const conversation = (await tx.scanConversations({ ownerTaskId: task }, 1)).items[0];
      if (conversation === undefined)
        throw new Error(`successor: child task ${task} has no conversation`);
      children.push({
        input: record.input,
        conversation: conversation.id,
        answer: outcome.status === "completed" ? outcome.result : undefined,
        status: outcome.status,
      });
    }
    return undefined;
  }, context);

  const rendered: string[] = [];
  for (const child of children) {
    if (child.input.kind === "researcher") {
      rendered.push(
        `<researcher conversation="${child.conversation}">\n<answer>\n${child.answer ?? `Researcher ${child.status}.`}\n</answer>\n</researcher>`,
      );
      continue;
    }
    if (cwd === undefined) throw new Error("successor: no cwd for worker diffs");
    const branch = workerBranch(child.input.name);
    const diff = (await git(["diff", `${child.input.base}...${branch}`], cwd)).trim();
    rendered.push(
      diff.length > 0
        ? `<worker name="${child.input.name}" branch="${branch}" conversation="${child.conversation}">\n<diff>\n${diff}\n</diff>\n</worker>`
        : `<worker name="${child.input.name}" branch="${branch}" conversation="${child.conversation}">\n<answer>\n${child.answer ?? `Worker ${child.status}.`}\n</answer>\n</worker>`,
    );
  }
  return [
    `Successor of conversation #${predecessor}.`,
    "",
    ...rendered,
    "",
    "Use ask to consult any conversation above for further detail.",
  ].join("\n");
}

type ConversationTaskDefinition = ReturnType<typeof conversationTask>;

async function createConversationTask(
  tx: Tx,
  taskDefinition: ConversationTaskDefinition,
  input: ConversationTaskInput,
): Promise<TaskId<string>> {
  return tx.createTask(taskDefinition, input, {
    ownership: { kind: "conversation" },
    background: true,
  });
}

/** The successor's task, without keeping the completed run busy with it. */
type SuccessorInput = { readonly on: TaskId<string>[] };

const successorTask = (taskDefinition: ConversationTaskDefinition) =>
  defineTask<SuccessorInput, { readonly phase: "schedule" }, null>({
    name: "key.successor",
    version: 1,
    initial: () => ({ phase: "schedule" }),
    phases: {
      schedule: async (record, runtime, context) => {
        await runtime.commit(async (tx) => {
          await createConversationTask(tx, taskDefinition, {
            kind: "successor",
            on: record.input.on,
          });
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: async (_record, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });

/** A replay of one child tool call reattaches to the child its first attempt created. */
const ChildCreation = defineDoc<{ taskId?: TaskId<string> }>({
  kind: "key.child",
  version: 1,
  scope: "task",
  initial: () => ({}),
  checkpointWhen: () => false,
});

function childTools(git: Git, models: () => Models, taskDefinition: ConversationTaskDefinition) {
  const Delegate = defineTool({
    name: "delegate",
    description:
      "Start a worker immediately in its own git worktree and conversation. Returns without waiting. When this run ends, a fresh successor starts after all its children settle and receives their results.",
    parameters: Type.Object({
      name: Type.String({
        pattern: WORKER_NAME.source,
        description: "Lowercase kebab-case worker name; its branch is worker/<name>.",
      }),
      prompt: Type.String({
        description: "A self-contained implementation task and its success criteria.",
      }),
    }),
    replay: "safe",
    execute: async ({ prompt, name }, call, context) => {
      const repo = (await call.agent(context)).cwd;
      if (repo === undefined) throw new Error("delegate: no cwd to make a worktree from");
      const worker = await ensureWorker(name, git, repo);
      const taskId = await call.commit(async (tx) => {
        const creation = await tx.doc(ChildCreation, call.taskId);
        if (creation.taskId !== undefined) return creation.taskId;
        const task = await createConversationTask(tx, taskDefinition, {
          kind: "worker",
          prompt,
          name,
          base: worker.base,
        });
        const conversation = await tx.createConversation({
          ownership: { kind: "task", taskId: task },
        });
        await configureChild(tx, conversation.id, models, {
          cwd: worker.path,
          instructions: WORKER_INSTRUCTIONS,
          remove: [Delegate, Research, Ask],
        });
        creation.taskId = task;
        return task;
      }, context);
      return {
        output: [{ type: "text", text: `Started worker task #${taskId}.` }],
        details: { taskId },
      };
    },
  });

  const Research = defineTool({
    name: "research",
    description:
      "Start a researcher immediately in a fresh conversation without a worktree. Returns without waiting. When this run ends, a fresh successor starts after all its children settle and receives their results.",
    parameters: Type.Object({
      prompt: Type.String({
        description: "A self-contained research question and the findings needed.",
      }),
    }),
    replay: "safe",
    execute: async ({ prompt }, call, context) => {
      const cwd = (await call.agent(context)).cwd;
      const taskId = await call.commit(async (tx) => {
        const creation = await tx.doc(ChildCreation, call.taskId);
        if (creation.taskId !== undefined) return creation.taskId;
        const task = await createConversationTask(tx, taskDefinition, {
          kind: "researcher",
          prompt,
        });
        const conversation = await tx.createConversation({
          ownership: { kind: "task", taskId: task },
        });
        await configureChild(tx, conversation.id, models, {
          cwd,
          instructions: RESEARCHER_INSTRUCTIONS,
          remove: [Delegate, Research, Ask],
        });
        creation.taskId = task;
        return task;
      }, context);
      return {
        output: [{ type: "text", text: `Started researcher task #${taskId}.` }],
        details: { taskId },
      };
    },
  });
  return { Delegate, Research };
}

async function configureChild(
  tx: Tx,
  conversation: ConversationId,
  models: () => Models,
  options: {
    readonly cwd: string | undefined;
    readonly instructions: string;
    readonly remove: readonly ReturnType<typeof defineTool>[];
  },
): Promise<void> {
  const child = (await tx.doc(ModelDefaultsDoc)).child;
  if (child === undefined) throw new Error("child: no model default: set one with /model");
  const model = models().getModel(child.provider, child.modelId);
  if (model === undefined)
    throw new Error(`child: unknown model ${child.provider}/${child.modelId}`);
  const level = (await tx.doc(ThinkingDefaultsDoc)).child ?? DEFAULT_THINKING_LEVEL;
  await configure(tx, conversation, {
    cwd: options.cwd,
    model: child,
    thinkingLevel: clampThinkingLevel(model, level),
    instructions: options.instructions,
    tools: { remove: options.remove },
  });
}

/** One question answered in a private copy of a settled conversation; the original is untouched. */
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
      let copyId = record.state.checkpoint.conversationId;
      if (copyId === undefined) {
        await runtime.commit(async (tx) => {
          copyId = (await tx.scanConversations({ ownerTaskId: record.id }, 1)).items[0]?.id;
          if (copyId === undefined) {
            const at = await tx.latestEntryId(conversation);
            if (at === undefined)
              throw new Error(`key.ask ${record.id}: conversation #${conversation} is empty`);
            copyId = (
              await tx.forkConversation(conversation, at, {
                ownership: { kind: "task", taskId: record.id },
              })
            ).id;
          }
          return { status: "running", checkpoint: { phase: "ask", conversationId: copyId } };
        }, context);
      }
      if (copyId === undefined) throw new Error(`key.ask ${record.id}: no conversation copy`);
      const handle = await runtime.conversation(copyId, context);
      if (handle === undefined)
        throw new Error(`key.ask ${record.id}: conversation ${copyId} is gone`);

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
    "Ask a settled conversation a question. It answers in a private copy of its own context, with its tools; the conversation itself is never modified. Batch compound questions into one ask; several asks may run in parallel.",
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
  const ConversationTask = conversationTask(git);
  const SuccessorTask = successorTask(ConversationTask);
  const { Delegate, Research } = childTools(git, models, ConversationTask);
  return {
    extension: defineExtension({
      name: "key",
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
                  (message.toolName !== "delegate" && message.toolName !== "research") ||
                  message.isError
                )
                  continue;
                const taskId = (message.details as { readonly taskId?: TaskId<string> } | undefined)
                  ?.taskId;
                if (taskId === undefined)
                  throw new Error(`child result ${entry.id} has no task ID`);
                on.push(taskId);
              }
              cursor = page.next;
            } while (cursor !== undefined);
            if (on.length === 0) return undefined;
            return { tasks: [runEndTask(SuccessorTask, { on })] };
          },
        }),
      ],
      tasks: [ConversationTask, SuccessorTask, AskTask],
      tools: [Delegate, Research, Ask],
    }),
    task: ConversationTask,
  };
};
