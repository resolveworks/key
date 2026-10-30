import { contentText, Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
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
  ToolResultEntry,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Git } from "./git.ts";
import { branchFor, CHILD_NAME, ensureWorktree } from "./worktree.ts";

/** A fork or successor: one prompt in the conversation this task owns. */
export type KeyTaskInput =
  | {
      readonly prompt: string;
      /** The fork's worktree and branch; forks cannot fork again. */
      readonly name: string;
    }
  | {
      readonly prompt: string;
      /** The fork tasks whose settled results join into this successor's prompt. */
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
      const on = "on" in record.input ? record.input.on : undefined;
      if (on !== undefined) {
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

      const { prompt } = record.input;
      const on = "on" in record.input ? record.input.on : undefined;
      const upstream =
        on === undefined
          ? []
          : (await runtime.outcomes(on, context)).map((outcome, index) =>
              outcome.status === "completed"
                ? `task #${on[index]} completed:\n${outcome.result}`
                : `task #${on[index]} ${outcome.status}`,
            );
      const text =
        upstream.length === 0
          ? prompt
          : `${prompt}\n\nUpstream results:\n\n${upstream.join("\n\n")}`;
      const submission = await handle.submit(
        {
          type: "input",
          content:
            "name" in record.input
              ? `You work in an isolated git worktree on branch ${branchFor(record.input.name)}. Commit all work before you finish.\n\n${text}`
              : text,
          requestId: `key.run:${record.id}`,
          whenBusy: "steer",
        },
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

/** Create one asynchronous branch and the conversation it owns, in the current conversation. */
/** Create a run's task; a successor mints no conversation here — its wait ends first, and the
 * conversation it runs in is minted when the wait does. */
async function createRun(tx: Tx, input: KeyTaskInput): Promise<TaskId<string>> {
  return tx.createTask(KeyTask, input, {
    ownership: { kind: "conversation" },
    background: true,
  });
}

/** The successor a completed run requests: its final answer and the forks to join. */
type SpawnInput = { readonly prompt: string; readonly on: TaskId<string>[] };

/** Create the successor's task without keeping the completed run busy with it; the conversation
 * is minted when the successor's wait ends, so the heir lists newer than every fork it joins. */
const SpawnTask = defineTask<SpawnInput, { readonly phase: "spawn" }, null>({
  name: "key.spawn",
  version: 1,
  initial: () => ({ phase: "spawn" }),
  phases: {
    spawn: async (record, runtime, context) => {
      await runtime.commit(async (tx) => {
        await createRun(tx, { prompt: record.input.prompt, on: record.input.on });
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
      "Start one child task immediately in its own git worktree and conversation. The name becomes the child's branch agent/<name>; commit all work before finishing. You do not wait for it. Call fork once per child; calling it several times forks several children. When your run answers, a fresh successor starts once all its children settle, with your final answer and their results. A child does not fork.",
    parameters: Type.Object({
      name: Type.String({
        pattern: CHILD_NAME.source,
        description: "Lowercase kebab-case child name; also its branch agent/<name>.",
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
        const task = await createRun(tx, { prompt, name });
        const conversation = await tx.createConversation({
          ownership: { kind: "task", taskId: task },
        });
        await configure(tx, conversation.id, {
          cwd: worktree.path,
          tools: { remove: [Fork] },
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
            const answer = await api.entry(AssistantEntry, run.answer, context);
            return { tasks: [runEndTask(SpawnTask, { prompt: answerOf(answer), on })] };
          },
        }),
      ],
      tasks: [KeyTask, SpawnTask],
      tools: [Fork],
    }),
    task: KeyTask,
  };
};
