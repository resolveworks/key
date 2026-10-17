import { Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineExtension,
	defineTask,
	defineTool,
	type TaskId,
} from "@earendil-works/pi-durable";

export type KeyTaskInput = {
	readonly prompt: string;
	/** Continue this existing conversation instead of creating one. */
	readonly conversationId?: ConversationId;
	/** This is a join: wait on these worker leaves, then run with their results folded into the prompt. */
	readonly on?: readonly TaskId<string>[];
};

type KeyTaskState =
	| { readonly phase: "wait" }
	| { readonly phase: "run"; readonly conversationId?: ConversationId };

/**
 * One context: a prompt plus the conversation it runs in. A context emits worker leaves and goes
 * terminal; at terminal it mints the join over the workers it emitted. Nothing returns to it.
 */
export const KeyTask = defineTask<KeyTaskInput, KeyTaskState, string>({
	name: "key.task",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		// A join parks here until its leaves settle; a worker or a root orchestrator starts at once.
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
			let conversationId = task.state.checkpoint.conversationId ?? task.input.conversationId;
			if (conversationId === undefined) {
				// Save the intent before acting: a crash after the submit reacquires this same conversation.
				await runtime.commit(async (tx) => {
					conversationId = (
						await tx.createConversation({ ownership: { kind: "task", taskId: task.id } })
					).id;
					return { status: "running", checkpoint: { phase: "run", conversationId } };
				}, context);
			}
			if (conversationId === undefined) throw new Error(`key.task ${task.id}: no conversation`);
			const runConversation = conversationId;
			const handle = await runtime.conversation(runConversation, context);
			if (handle === undefined)
				throw new Error(`key.task ${task.id}: conversation ${runConversation} is gone`);

			// The join prompt: the emitter's last turn (control) plus every leaf's settled result (data).
			const on = task.input.on;
			let prompt = task.input.prompt;
			if (on !== undefined && on.length > 0) {
				const outcomes = await runtime.outcomes(on, context);
				const upstream = outcomes.map((outcome, index) =>
					outcome.status === "completed"
						? `task #${on[index]} completed:\n${outcome.result}`
						: `task #${on[index]} ${outcome.status}`,
				);
				prompt += `\n\nUpstream results:\n\n${upstream.join("\n\n")}`;
			}

			const submission = await handle.submit(
				{ type: "input", content: prompt, requestId: `key.task:${task.id}` },
				context,
			);
			const settled = await submission.wait(context);
			if (settled.status !== "done" || settled.type !== "input") {
				throw new Error(`key.task ${task.id}: run ended ${settled.status}`);
			}

			const view = await runtime.context(runConversation, context);
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

			// One commit: this context ends, and the contexts it emitted are born in its conversation.
			// Background keeps the emitter from waiting on them; the join waits on them explicitly.
			await runtime.commit(async (tx) => {
				const workers: TaskId<string>[] = [];
				for (const workerPrompt of emitted) {
					workers.push(
						await tx.createTask(
							KeyTask,
							{ prompt: workerPrompt },
							{
								ownership: { kind: "conversation" },
								conversationId: runConversation,
								background: true,
							},
						),
					);
				}
				if (workers.length > 0) {
					await tx.createTask(
						KeyTask,
						{ prompt: result, on: workers },
						{
							ownership: { kind: "conversation" },
							conversationId: runConversation,
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
 * parallel work. The context materializes the calls when its turn ends and mints the join over them.
 */
export const Emit = defineTool({
	name: "emit",
	description:
		"Emit one worker context: a fresh context that runs the given task when your turn ends. You do not wait for it. Call emit once per piece of work; make several calls in the same turn for parallel work. When your turn ends, every worker is created and a join waiting on all of them starts with your last message as its prompt.",
	parameters: Type.Object({
		prompt: Type.String({ description: "The task for the worker context." }),
	}),
	replay: "safe",
	execute: async () => ({ output: [{ type: "text", text: "Emitted." }] }),
});

export const KeySystem = defineExtension({
	name: "key",
	tasks: [KeyTask],
	tools: [Emit],
});
