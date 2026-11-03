import type { Context } from "@earendil-works/chord";
import { clampThinkingLevel, contentText, type Models } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  AssistantEntry,
  type ConversationHandle,
  type ConversationId,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type EntryId,
  type EntryRecord,
  GenerationTask,
  hook,
  runEndTask,
  section,
  type TaskId,
  type TaskRecord,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { num, obj, str } from "@earendil-works/pi-schema";
import type { Git } from "./git.ts";
import { ModelDefaultsDoc } from "./models.ts";
import { DEFAULT_THINKING_LEVEL, ThinkingDefaultsDoc } from "./thinking.ts";
import { ensureWorker, repoSlug, WORKER_NAME, workerBranch } from "./worker.ts";

export const CONVERSATION_INSTRUCTIONS = `
<role>
You coordinate the user's coding task during this run. Answer directly, delegate
implementation or research, or evaluate and integrate child results already
supplied to you rather than merely relaying them.
</role>

<delegation>
Default to delegate for implementation instead of editing the current checkout.
Direct edits are the exception, reserved for trivial changes and integration or
conflict resolution that cannot sensibly be delegated.

Use research for non-trivial investigations that benefit from isolated context
or parallel work. Perform quick lookups directly, but never duplicate research
already assigned to a researcher.

Give every child a self-contained prompt containing the goal, relevant context
and constraints, scope or file ownership, success criteria, and required
verification. Launch independent children for the current wave in parallel.
</delegation>

<handoff>
delegate and research start separate conversations; they are not background jobs
within your run. Once you have launched the current wave, your run is complete.
End it immediately with a brief status. Do not continue the delegated work, wait,
poll, or ask in-flight children for results.

After the children settle, a separate successor conversation receives their
results and decides what to do next. Use ask to consult settled earlier
conversations for missing goals or context instead of guessing.
</handoff>
`;
export const WORKER_INSTRUCTIONS =
  "You are an implementation worker completing one delegated task in your own git worktree and branch. Stay within the requested scope. Implement and test the changes, and commit any resulting work before finishing. If you cannot finish, commit a sound checkpoint. Report what changed, how you verified it, and anything left undone.";
export const RESEARCHER_INSTRUCTIONS =
  "You are a researcher answering one delegated question in a fresh context. Investigate the relevant code, documentation, or external sources. Produce findings, not code changes. Return a self-contained answer with concrete source references, distinguish verified facts from inference, and state any remaining uncertainties.";

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
    // A worker or researcher has nothing to wait for; a successor waits for its children.
    initial: (input) => (input.kind === "successor" ? { phase: "wait" } : { phase: "run" }),
    phases: {
      wait: async (record, runtime, context) => {
        if (record.input.kind !== "successor")
          throw new Error(`key.conversation ${record.id}: only a successor waits`);
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

/** What answerOfRun and successorPrompt need of a runtime or tool api: one commit. */
type Commits = {
  commit(change: (tx: Tx) => unknown, context: Context): Promise<unknown>;
};

/** Submit one prompt to a conversation and return its answer; `undefined` when the run aborted. */
async function answerOfRun(
  handle: ConversationHandle,
  commits: Commits,
  context: Context,
  key: string,
  text: string,
): Promise<string | undefined> {
  const submission = await handle.submit({ type: "input", content: text, requestId: key }, context);
  const settled = await submission.wait(context);
  if (settled.status === "unanswered" && settled.reason === "aborted") return undefined;
  if (settled.status !== "done" || settled.type !== "input") {
    throw new Error(
      `${key}: run ended ${settled.status}` +
        (settled.status === "unanswered" ? `: ${settled.reason}` : ""),
    );
  }
  let entry: EntryRecord | undefined;
  await commits.commit(async (tx) => {
    entry = await tx.entry(AssistantEntry, settled.answer);
  }, context);
  return answerOf(entry);
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
  runtime: Commits,
  context: Context,
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
    const branch = workerBranch(
      repoSlug((await git(["rev-parse", "--show-toplevel"], cwd)).trim()),
      child.input.name,
    );
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

/**
 * The successor's task, without keeping the completed run busy with it.
 *
 * It cannot be created directly in `afterRun`: a hook's api is read-only (a
 * `DocumentReader` with memos), so the only way to start work there is a
 * `runEndTask()`, which the generation creates as its own child and waits for
 * until it is terminal — and it takes no ownership or background options. A
 * ConversationTask successor would hold the run, and the conversation, open
 * until it finished answering. This task commits the conversation-owned,
 * background successor and terminates at once, so the run ends immediately.
 */
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
          // The joined children are settled now; drop their records so the doc stays small.
          const children = await tx.doc(RunChildren, record.conversationId);
          for (const [call, started] of Object.entries(children))
            if (record.input.on.includes(started.child)) delete children[call];
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: async (_record, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });

/**
 * Each child a conversation's calls started, keyed by the starting tool-call
 * task (so a replay reattaches) with the entry that was current when it did
 * (so afterRun takes only the ones its run covers). A run's generation tasks
 * come and go; its entry range does not.
 */
const RunChildren = defineDoc<
  Record<string, { readonly entry: EntryId; readonly child: TaskId<string> }>
>({
  kind: "key.run-children",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
  checkpointWhen: () => false,
});

/** Start one child in a fresh conversation, reattaching on replay; `configure` gives it its shape. */
async function startChild(
  api: ToolExecutionApi,
  context: Context,
  taskDefinition: ConversationTaskDefinition,
  input: Extract<ConversationTaskInput, { kind: "worker" | "researcher" }>,
  configure: (tx: Tx, conversation: ConversationId) => Promise<void>,
): Promise<TaskId<string>> {
  return api.commit(async (tx) => {
    const children = await tx.doc(RunChildren, api.conversationId);
    const existing = children[api.taskId];
    if (existing !== undefined) return existing.child;
    const entry = await tx.latestEntryId(api.conversationId);
    if (entry === undefined)
      throw new Error(`startChild: conversation ${api.conversationId} is empty`);
    const task = await createConversationTask(tx, taskDefinition, input);
    const conversation = await tx.createConversation({
      ownership: { kind: "task", taskId: task },
    });
    await configure(tx, conversation.id);
    children[api.taskId] = { entry, child: task };
    return task;
  }, context);
}

function childTools(git: Git, taskDefinition: ConversationTaskDefinition) {
  async function configureChild(
    tx: Tx,
    conversation: ConversationId,
    models: Models,
    options: { readonly cwd: string | undefined; readonly instructions: string },
  ): Promise<void> {
    const child = (await tx.doc(ModelDefaultsDoc)).child;
    if (child === undefined) throw new Error("child: no model default: set one with /model");
    const model = models.getModel(child.provider, child.modelId);
    if (model === undefined)
      throw new Error(`child: unknown model ${child.provider}/${child.modelId}`);
    const level = (await tx.doc(ThinkingDefaultsDoc)).child ?? DEFAULT_THINKING_LEVEL;
    await configure(tx, conversation, {
      cwd: options.cwd,
      model: child,
      thinkingLevel: clampThinkingLevel(model, level),
      instructions: options.instructions,
      tools: { remove: [Delegate, Research, Ask] },
    });
  }

  const Delegate = defineTool({
    name: "delegate",
    description:
      "Start an implementation worker in its own git worktree and fresh conversation. Use this by default for implementation rather than editing the current checkout. This call only starts the worker; it does not return the worker's result. After launching all independent workers for the current wave, end this run immediately. Do not implement the delegated task locally, wait, or poll. A separate successor conversation receives the children's diffs and results after they settle; you will not resume to collect them.",
    parameters: obj({
      name: str({
        pattern: WORKER_NAME.source,
        description: "Lowercase kebab-case worker name; its branch is worker/<repo>/<name>.",
      }),
      prompt: str({
        description:
          "A self-contained implementation assignment: goal, relevant context and constraints, scope or file ownership, success criteria, and required verification. The worker commits its changes.",
      }),
    }),
    replay: "safe",
    execute: async ({ prompt, name }, api, context) => {
      const repo = (await api.agent(context)).cwd;
      if (repo === undefined) throw new Error("delegate: no cwd to make a worktree from");
      const worker = await ensureWorker(name, git, repo);
      const taskId = await startChild(
        api,
        context,
        taskDefinition,
        { kind: "worker", prompt, name, base: worker.base },
        (tx, conversation) =>
          configureChild(tx, conversation, api.models, {
            cwd: worker.path,
            instructions: WORKER_INSTRUCTIONS,
          }),
      );
      return {
        output: [
          {
            type: "text",
            text: `Started worker task #${taskId}. End this run; a separate successor conversation will receive its diff and result.`,
          },
        ],
      };
    },
  });

  const Research = defineTool({
    name: "research",
    description:
      "Start a researcher in a fresh conversation to investigate and report findings without changing code. Use this for non-trivial research benefiting from isolated context or parallel investigation. This call only starts the researcher; it does not return findings. After launching all independent researchers for the current wave, end this run immediately. Do not duplicate the research locally, wait, poll, or ask the researcher for results. A separate successor conversation receives the findings after the children settle; you will not resume to collect them.",
    parameters: obj({
      prompt: str({
        description:
          "A self-contained research assignment: context, question, relevant sources or scope, exact findings required, and success criteria. Research only; no code changes.",
      }),
    }),
    replay: "safe",
    execute: async ({ prompt }, api, context) => {
      const cwd = (await api.agent(context)).cwd;
      const taskId = await startChild(
        api,
        context,
        taskDefinition,
        { kind: "researcher", prompt },
        (tx, conversation) =>
          configureChild(tx, conversation, api.models, {
            cwd,
            instructions: RESEARCHER_INSTRUCTIONS,
          }),
      );
      return {
        output: [
          {
            type: "text",
            text: `Started researcher task #${taskId}. End this run; a separate successor conversation will receive its findings.`,
          },
        ],
      };
    },
  });
  return { Delegate, Research };
}

/** Ask one settled conversation a question: it answers in a private fork of its own context. */
const Ask = defineTool({
  name: "ask",
  description:
    "Ask a settled conversation a question. It answers in a private copy of its own context, with its tools; the conversation itself is never modified. Batch compound questions into one ask; several asks may run in parallel.",
  parameters: obj({
    conversation: num({ description: "The conversation id from the framing." }),
    question: str({ description: "The question to answer from that conversation." }),
  }),
  replay: "safe",
  execute: async ({ conversation, question }, api, context) => {
    const target = conversation as ConversationId;
    const fork = await api.commit(async (tx) => {
      // The ownership index remembers the fork, so a replay or restart reuses it.
      const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
      if (existing !== undefined) return existing.id;
      const at = await tx.latestEntryId(target);
      if (at === undefined) throw new Error(`ask: conversation #${target} is empty`);
      return (
        await tx.forkConversation(target, at, {
          ownership: { kind: "task", taskId: api.taskId },
        })
      ).id;
    }, context);
    const handle = await api.conversation(fork, context);
    if (handle === undefined) throw new Error(`ask: conversation fork ${fork} is gone`);
    const answer = await answerOfRun(handle, api, context, `key.ask:${api.taskId}`, question);
    if (answer === undefined) throw new Error("ask failed: aborted");
    return { output: [{ type: "text", text: answer }] };
  },
});

/** The host's system: direct conversation runs, with tasks only at cascade boundaries. */
export const keySystem = (git: Git) => {
  const ConversationTask = conversationTask(git);
  const SuccessorTask = successorTask(ConversationTask);
  const { Delegate, Research } = childTools(git, ConversationTask);
  return defineExtension({
    name: "key",
    sections: [
      section(
        "preamble",
        () => "You are an agent operating inside key, a durable coding-agent harness.",
        { tag: false },
      ),
    ],
    hooks: [
      hook(GenerationTask, {
        afterRun: async (run, api, context) => {
          // The children the tools started, already recorded; only this run's range joins.
          const children = await api.snapshot(RunChildren, api.conversationId, context);
          const on =
            children === undefined
              ? []
              : Object.values(children)
                  .filter((started) => started.entry >= run.first && started.entry <= run.last)
                  .map((started) => started.child);
          if (on.length === 0) return undefined;
          return { tasks: [runEndTask(SuccessorTask, { on })] };
        },
      }),
    ],
    tasks: [ConversationTask, SuccessorTask],
    tools: [Delegate, Research, Ask],
  });
};
