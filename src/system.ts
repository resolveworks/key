import { Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	configure,
	defineExtension,
	defineTask,
	defineTool,
	section,
	type TaskId,
} from "@earendil-works/pi-durable";
import { branchFor, CHILD_NAME, ensureWorktree, type Worktree } from "./worktree.ts";

export type KeyTaskInput = {
	readonly prompt: string;
	/** The child's name: it names the worktree and branch agent/<name>. */
	readonly name?: string;
	/** Set for a context a parent forked: it runs in a fresh conversation without fork. */
	readonly child?: true;
	/** A human's message to an existing context: run it in that context's conversation. */
	readonly continue?: true;
	readonly on?: readonly TaskId<string>[];
};

type KeyTaskState =
	| { readonly phase: "wait" }
	| { readonly phase: "run"; readonly conversationId?: ConversationId };

/**
 * One context: a prompt and the conversation it runs in. It runs once and ends. At terminal it mints
 * its children and a fresh successor as tasks in this conversation; each creates its own conversation
 * when it runs.
 */
export const KeyTask = defineTask<KeyTaskInput, KeyTaskState, string>({
	name: "key.task",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		// A context with wait edges parks until they settle; anything else starts at once.
		wait: async (task, runtime, context) => {
			const on = task.input.on;
			if (on !== undefined && on.length > 0) {
				await runtime.commit(
					() => ({ status: "waiting", on, policy: "allSettled", checkpoint: { phase: "run" } }),
					context,
				);
				return;
			}
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "run" } }), context);
		},
		run: async (task, runtime, context) => {
			// Save the intent before acting: a crash after the submit reacquires this same conversation.
			let conversationId = task.state.checkpoint.conversationId;
			if (conversationId === undefined) {
				const target = task.input.continue === true ? runtime.conversationId : undefined;
				let worktree: Worktree | undefined;
				if (target === undefined && task.input.child === true) {
					if (task.input.name === undefined)
						throw new Error(`key.task ${task.id}: child has no name`);
					const env = await runtime.env(context);
					if (env === undefined) throw new Error(`key.task ${task.id}: child has no environment`);
					worktree = await ensureWorktree(task.input.name, env, context);
				}
				await runtime.commit(async (tx) => {
					conversationId =
						target ??
						(await tx.createConversation({ ownership: { kind: "task", taskId: task.id } })).id;
					if (worktree !== undefined) {
						await configure(tx, conversationId, {
							tools: { remove: [Fork] },
							cwd: worktree.path,
						});
					}
					return { status: "running", checkpoint: { phase: "run", conversationId } };
				}, context);
			}
			if (conversationId === undefined) throw new Error(`key.task ${task.id}: no conversation`);

			const handle = await runtime.conversation(conversationId, context);
			if (handle === undefined)
				throw new Error(`key.task ${task.id}: conversation ${conversationId} is gone`);

			// The prompt: the input (control) plus every waited-on task's settled result (data).
			const { prompt, name, on } = task.input;
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
						task.input.child === true && name !== undefined
							? `You work in an isolated git worktree on branch ${branchFor(name)}. Commit all work before you finish.\n\n${text}`
							: text,
					requestId: `key.task:${task.id}`,
				},
				context,
			);
			const settled = await submission.wait(context);
			if (settled.status !== "done" || settled.type !== "input") {
				throw new Error(`key.task ${task.id}: run ended ${settled.status}`);
			}

			const view = await runtime.context(conversationId, context);
			const message = view.entries.find((entry) => entry.id === settled.answer)?.model?.[0];
			if (message?.role !== "assistant")
				throw new Error(`key.task ${task.id}: answer ${settled.answer} has no assistant message`);
			const result = message.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("");
			// Every fork call the run made, across its tool rounds; the transcript is the fork record.
			const forked = view.entries
				.filter((entry) => entry.id >= settled.entry && entry.id <= settled.answer)
				.flatMap((entry) => entry.model ?? [])
				.flatMap((message) => {
					if (message.role !== "assistant") return [];
					return message.content.flatMap((part) => {
						if (part.type !== "toolCall" || part.name !== Fork.name) return [];
						const { prompt, name } = part.arguments;
						if (typeof prompt !== "string")
							throw new Error(`key.task ${task.id}: fork ${part.id} has no prompt`);
						if (typeof name !== "string")
							throw new Error(`key.task ${task.id}: fork ${part.id} has no name`);
						return [{ prompt, name }];
					});
				});

			// This context ends and its children are born in its conversation. Background keeps it from
			// waiting on them; the successor waits on them explicitly.
			await runtime.commit(async (tx) => {
				const children: TaskId<string>[] = [];
				for (const { prompt: childPrompt, name } of forked) {
					children.push(
						await tx.createTask(
							KeyTask,
							{ prompt: childPrompt, name, child: true },
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
						KeyTask,
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
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

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
	execute: async () => ({ output: [{ type: "text", text: "Forked." }] }),
});

export const KeySystem = defineExtension({
	name: "key",
	// Installed after the coding tools, so the framing renders ahead of project context. Untagged like pi's.
	sections: [
		section(
			"preamble",
			() =>
				"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
			{ tag: false },
		),
	],
	tasks: [KeyTask],
	tools: [Fork],
});
