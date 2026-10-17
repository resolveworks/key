import { Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineExtension,
	defineTask,
	defineTool,
	section,
	type TaskId,
} from "@earendil-works/pi-durable";

export type KeyTaskInput = {
	readonly prompt: string;
	/** Continue this existing conversation instead of creating one. */
	readonly conversationId?: ConversationId;
	readonly on?: readonly TaskId<string>[];
};

type KeyTaskState =
	| { readonly phase: "wait" }
	| { readonly phase: "run"; readonly conversationId?: ConversationId };

/**
 * One context: a prompt plus the conversation it runs in. Nothing returns to it; at terminal, if it
 * emitted, it mints the children it emitted, and a copy of its own message that runs once they settle.
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
			const { prompt, on } = task.input;
			// Save the intent before acting: a crash after the submit reacquires this same conversation.
			let conversationId = task.state.checkpoint.conversationId ?? task.input.conversationId;
			if (conversationId === undefined) {
				await runtime.commit(async (tx) => {
					conversationId = (
						await tx.createConversation({ ownership: { kind: "task", taskId: task.id } })
					).id;
					return { status: "running", checkpoint: { phase: "run", conversationId } };
				}, context);
			}
			if (conversationId === undefined) throw new Error(`key.task ${task.id}: no conversation`);

			const handle = await runtime.conversation(conversationId, context);
			if (handle === undefined)
				throw new Error(`key.task ${task.id}: conversation ${conversationId} is gone`);

			// The prompt: the input (control) plus every waited-on task's settled result (data).
			const upstream =
				on === undefined
					? []
					: (await runtime.outcomes(on, context)).map((outcome, index) =>
							outcome.status === "completed"
								? `task #${on[index]} completed:\n${outcome.result}`
								: `task #${on[index]} ${outcome.status}`,
						);
			const submission = await handle.submit(
				{
					type: "input",
					content:
						upstream.length === 0
							? prompt
							: `${prompt}\n\nUpstream results:\n\n${upstream.join("\n\n")}`,
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
			// Every emit call the run made, across its tool rounds; the transcript is the emit record.
			const emitted = view.entries
				.filter((entry) => entry.id >= settled.entry && entry.id <= settled.answer)
				.flatMap((entry) => entry.model ?? [])
				.flatMap((message) => {
					if (message.role !== "assistant") return [];
					return message.content.flatMap((part) => {
						if (part.type !== "toolCall" || part.name !== Emit.name) return [];
						if (typeof part.arguments.prompt !== "string")
							throw new Error(`key.task ${task.id}: emit ${part.id} has no prompt`);
						return [part.arguments.prompt];
					});
				});

			// One commit: this context ends, and its children are born in its conversation. Background
			// keeps it from waiting on them; the copy of its message waits on them instead.
			await runtime.commit(async (tx) => {
				const children: TaskId<string>[] = [];
				for (const childPrompt of emitted) {
					children.push(
						await tx.createTask(
							KeyTask,
							{ prompt: childPrompt },
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
 * The only verb a context uses: one piece of work per call. Call it more than once in a turn for
 * parallel work. The context materializes the calls when its turn ends, and its message re-runs once
 * they settle.
 */
export const Emit = defineTool({
	name: "emit",
	description:
		"Emit one child context: it runs the given task when your turn ends. You do not wait for it, and it emits nothing of its own. Call emit once per piece of work; make several calls in the same turn for parallel work. When your turn ends, every child is created and your last message runs again once they all settle, with their results.",
	parameters: Type.Object({
		prompt: Type.String({ description: "The task for the child context." }),
	}),
	replay: "safe",
	execute: async () => ({ output: [{ type: "text", text: "Emitted." }] }),
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
	tools: [Emit],
});
