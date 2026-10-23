import { Type } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  type EntryId,
  type EntryRecord,
  type Extension,
  section,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { Git } from "./git.ts";
import { branchFor, CHILD_NAME, ensureWorktree, type Worktree } from "./worktree.ts";

/** A context: a prompt run once in a conversation — its own when fresh, the one a continuation names. */
export type KeyTaskInput =
  | {
      readonly prompt: string;
      /** The settled results that join into the prompt before it runs: a successor's upstream. */
      readonly on?: readonly TaskId<string>[];
    }
  | {
      readonly prompt: string;
      /** A forked child: it runs in the worktree and branch its name mints, and cannot fork. */
      readonly name: string;
    }
  | {
      readonly prompt: string;
      /** A continuation: the conversation this prompt runs in, instead of a fresh one of its own. */
      readonly conversationId: ConversationId;
    };

/**
 * The forks one run called, as the tool tasks that settled them: the fork call, and the result a reader sees.
 * A call's result is recorded only when the call ran, so a refused fork is never in it.
 */
const ForkRecord = defineDoc({
  kind: "key.forks",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ forks: [] as { readonly prompt: string; readonly name: string }[] }),
});

type KeyTaskState =
  | { readonly phase: "wait" }
  | { readonly phase: "run"; readonly conversationId?: ConversationId };

/** The answer of a run: the final assistant text of the entry its submission settled on. */
const answerOf = (entries: readonly EntryRecord[], entryId: EntryId): string => {
  const message = entries.find((entry) => entry.id === entryId)?.model?.[0];
  if (message?.role !== "assistant") throw new Error(`answer ${entryId} has no assistant message`);
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
};

/**
 * One context: a prompt and the conversation it runs in — a fresh one of its own, or the one a
 * continuation names. It runs once and ends. At terminal it mints its children and a fresh successor
 * as tasks in this conversation; each creates its own conversation when it runs. The git port is
 * bound when the host installs key.
 */
export const keyTask = (git: Git) => {
  const task = defineTask<KeyTaskInput, KeyTaskState, string>({
    name: "key.task",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      // A context with wait edges parks until they settle; anything else starts at once.
      wait: async (record, runtime, context) => {
        const on = "on" in record.input ? record.input.on : undefined;
        if (on !== undefined && on.length > 0) {
          await runtime.commit(
            () => ({ status: "waiting", on, policy: "allSettled", checkpoint: { phase: "run" } }),
            context,
          );
          return;
        }
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "run" } }), context);
      },
      run: async (record, runtime, context) => {
        // Save the intent before acting: a crash after the submit reacquires this same conversation.
        let conversationId = record.state.checkpoint.conversationId;
        // A continuation runs in the conversation its input names.
        if (conversationId === undefined && "conversationId" in record.input) {
          conversationId = record.input.conversationId;
          await runtime.commit(
            () => ({ status: "running", checkpoint: { phase: "run", conversationId } }),
            context,
          );
        }
        if (conversationId === undefined) {
          // A fresh conversation copies this conversation's agent — cwd included — so only a child,
          // which moves to its checkout, configures anything.
          let worktree: Worktree | undefined;
          if ("name" in record.input) {
            const repo = (await runtime.agent(context)).cwd;
            if (repo === undefined)
              throw new Error(`key.task ${record.id}: no cwd to make a worktree from`);
            worktree = await ensureWorktree(record.input.name, git, repo);
          }
          await runtime.commit(async (tx) => {
            conversationId = (
              await tx.createConversation({ ownership: { kind: "task", taskId: record.id } })
            ).id;
            // A worktree child moves to its checkout and cannot fork.
            if (worktree !== undefined)
              await configure(tx, conversationId, {
                cwd: worktree.path,
                tools: { remove: [Fork] },
              });
            return { status: "running", checkpoint: { phase: "run", conversationId } };
          }, context);
        }
        if (conversationId === undefined) throw new Error(`key.task ${record.id}: no conversation`);

        const handle = await runtime.conversation(conversationId, context);
        if (handle === undefined)
          throw new Error(`key.task ${record.id}: conversation ${conversationId} is gone`);

        // The prompt: the input (control) plus every waited-on task's settled result (data).
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
            requestId: `key.task:${record.id}`,
            whenBusy: "steer",
          },
          context,
        );
        const settled = await submission.wait(context);
        if (settled.status === "unanswered" && settled.reason === "aborted") {
          // An interrupted context parks here: live, without a terminus, so whoever waits on it keeps
          // waiting. A restart finds the same settled submission by its request ID and parks again;
          // aborting the task is the one way out.
          await new Promise<void>((resolve) =>
            context.abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          return;
        }
        if (settled.status !== "done" || settled.type !== "input") {
          throw new Error(`key.task ${record.id}: run ended ${settled.status}`);
        }

        const result = answerOf(
          (await runtime.context(conversationId, context)).entries,
          settled.answer,
        );
        // This context ends and its children are born in its conversation, taking the forks this run
        // recorded — a later run here mints only its own. Background keeps it from waiting on them;
        // the successor waits on them explicitly.
        await runtime.commit(async (tx) => {
          const forks = (await tx.doc(ForkRecord, handle.id)).forks.splice(0);
          const children: TaskId<string>[] = [];
          for (const { prompt: childPrompt, name } of forks) {
            children.push(
              await tx.createTask(
                task,
                { prompt: childPrompt, name },
                {
                  ownership: { kind: "conversation" },
                  conversationId,
                  background: true,
                },
              ),
            );
          }
          if (children.length > 0) {
            await tx.createTask(
              task,
              { prompt: result, on: children },
              {
                ownership: { kind: "conversation" },
                conversationId,
                background: true,
              },
            );
          }
          return { status: "terminal", outcome: { status: "completed", result } };
        }, context);
      },
    },
    abort: async (_record, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
  return task;
};

/**
 * The only verb a context uses: fork one child per call. Call it several times in a turn for parallel
 * children. The context ends when its turn ends; a fresh successor runs once they settle, with their
 * results. A child does not fork.
 */
export const Fork = defineTool({
  name: "fork",
  description:
    "Fork one child context: it runs the given task in its own git worktree when your turn ends. The name becomes the child's branch agent/<name>; commit all work before finishing. You do not wait for it; the context ends when its turn ends. Call fork once per child; calling it several times in the same turn forks several children. A fresh successor runs once they settle, with their results. A child does not fork.",
  parameters: Type.Object({
    name: Type.String({
      pattern: CHILD_NAME.source,
      description: "Lowercase kebab-case child name; also its branch agent/<name>.",
    }),
    prompt: Type.String({ description: "The task for the child context." }),
  }),
  replay: "safe",
  execute: async ({ prompt, name }, call, context) => {
    await call.commit(async (tx) => {
      const record = await tx.doc(ForkRecord, call.conversationId);
      record.forks.push({ prompt, name });
    }, context);
    return { output: [{ type: "text", text: "Forked." }] };
  },
});

/** The host's system: key with its git bound. */
export const keySystem = (git: Git): Extension =>
  defineExtension({
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
    tasks: [keyTask(git)],
    tools: [Fork],
  });
