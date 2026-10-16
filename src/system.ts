import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationId,
	type Cursor,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	ROOT_CONVERSATION_ID,
	type TaskId,
} from "@earendil-works/pi-durable";

/** Session-scoped statement of what the project is; rendered into every context's prompt. */
export const GoalDoc = defineDoc({
	kind: "key.goal",
	version: 1,
	scope: "session",
	initial: () => ({ text: "" }),
});

export type KeyTaskInput = {
	readonly prompt: string;
	/** The emit call that created this context and this context's position in it, for idempotent replay. */
	readonly emission?: { readonly emitter: TaskId; readonly index: number };
};

type KeyTaskState =
	| { readonly phase: "wait" }
	| { readonly phase: "run"; readonly conversationId?: ConversationId };

/**
 * One context: a prompt plus the conversation it runs in. A context emits successors and goes
 * terminal; nothing returns to it. The emitted tasks are conversation-owned in the root
 * conversation, so an emitter is not held by the work it emits.
 */
export const KeyTask = defineTask<KeyTaskInput, KeyTaskState, string>({
	name: "key.task",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		// Born pending. This is where a joining context will instead commit a wait on its upstream tasks.
		wait: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "run" } }), context);
		},
		run: async (task, runtime, context) => {
			let conversationId = task.state.checkpoint.conversationId;
			if (conversationId === undefined) {
				// Save the intent before acting: a crash after the submit reacquires this same conversation.
				await runtime.commit(async (tx) => {
					conversationId = (await tx.createConversation({ ownership: { kind: "task", taskId: task.id } })).id;
					return { status: "running", checkpoint: { phase: "run", conversationId } };
				}, context);
			}
			if (conversationId === undefined) throw new Error(`key.task ${task.id}: no conversation`);
			const handle = await runtime.conversation(conversationId, context);
			if (handle === undefined) throw new Error(`key.task ${task.id}: conversation ${conversationId} is gone`);

			const goal = (await runtime.snapshot(GoalDoc, context))?.text ?? "";
			const content = goal === "" ? task.input.prompt : `# Goal\n\n${goal}\n\n---\n\n${task.input.prompt}`;
			const submission = await handle.submit(
				{ type: "input", content, requestId: `key.task:${task.id}` },
				context,
			);
			const settled = await submission.wait(context);
			if (settled.status !== "done" || settled.type !== "input") {
				throw new Error(`key.task ${task.id}: run ended ${settled.status}`);
			}

			const entry = await runtime.entry(AssistantEntry, settled.answer, context);
			const message = entry?.model?.[0] as AssistantMessage | undefined;
			const result = message?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ?? "";
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

/**
 * The only verb. Each entry becomes a fresh context. An emission is one commit; a replay after a
 * crash finds the contexts it already created by their emission marker instead of emitting twice.
 */
export const Emit = defineTool({
	name: "emit",
	description:
		"Emit successor contexts. Each runs the given task in a fresh context and may emit further. You do not wait for them; your turn ends once they are created.",
	parameters: Type.Object({
		tasks: Type.Array(
			Type.Object({ prompt: Type.String({ description: "The task for the successor context." }) }),
			{ description: "One entry per successor context." },
		),
	}),
	replay: "safe",
	execute: async (args, api, context) => {
		const ids = await api.commit(async (tx) => {
			const existing: { readonly id: number; readonly index: number }[] = [];
			let cursor: Cursor | undefined;
			for (;;) {
				const page = await tx.scanTasks(
					{ conversationId: ROOT_CONVERSATION_ID, kind: KeyTask.definition.name },
					256,
					cursor,
				);
				for (const record of page.items) {
					const input = record.input as { readonly emission?: { readonly emitter?: number; readonly index?: number } };
					if (input.emission?.emitter !== api.taskId) continue;
					existing.push({ id: record.id, index: input.emission.index ?? 0 });
				}
				if (page.next === undefined) break;
				cursor = page.next;
			}
			if (existing.length > 0) return existing.sort((a, b) => a.index - b.index).map((found) => found.id);

			const created: number[] = [];
			let index = 0;
			for (const spec of args.tasks) {
				created.push(
					await tx.createTask(
						KeyTask,
						{ prompt: spec.prompt, emission: { emitter: api.taskId, index } },
						{ ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID },
					),
				);
				index++;
			}
			return created;
		}, context);
		return { output: [{ type: "text", text: `Emitted ${ids.length} context(s): ${ids.join(", ")}.` }] };
	},
});

export const KeySystem = defineExtension({
	name: "key",
	tasks: [KeyTask],
	tools: [Emit],
});
