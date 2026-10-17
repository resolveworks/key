import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationId,
	type Cursor,
	defineExtension,
	defineTask,
	defineTool,
	ROOT_CONVERSATION_ID,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";

export type KeyTaskInput = {
	readonly prompt: string;
	/** The emit call that created this worker, for idempotent replay. */
	readonly emission?: { readonly emitter: TaskId; readonly call: string };
	/** This is a join: wait on these worker leaves, then run with their results folded into the prompt. */
	readonly on?: readonly TaskId<string>[];
	/** The line drained: a terminal leaf addressed to the human. Runs no model. */
	readonly human?: true;
};

type KeyTaskState =
	| { readonly phase: "wait" }
	| { readonly phase: "run"; readonly conversationId?: ConversationId };

/**
 * One context: a prompt plus the conversation it runs in. A context emits worker leaves and goes
 * terminal; at terminal it mints one successor — the join over the workers it emitted, or the human
 * when a join drains — built from the durable emit record. Nothing returns to it.
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
			// The human handoff is a terminal leaf: no conversation, no model turn.
			if (task.input.human === true) {
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "completed", result: task.input.prompt },
					}),
					context,
				);
				return;
			}

			let conversationId = task.state.checkpoint.conversationId;
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
			const handle = await runtime.conversation(conversationId, context);
			if (handle === undefined)
				throw new Error(`key.task ${task.id}: conversation ${conversationId} is gone`);

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

			const entry = await runtime.entry(AssistantEntry, settled.answer, context);
			const message = entry?.model?.[0] as AssistantMessage | undefined;
			const result =
				message?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ??
				"";

			// One commit: this context ends and mints its successor from the emit record.
			await runtime.commit(async (tx) => {
				const workers = await emittedBy(tx, task.id);
				if (workers.length > 0) {
					// Fork became a fork/join: the join is born waiting on the leaves it just emitted.
					await tx.createTask(
						KeyTask,
						{ prompt: result, on: workers },
						{ ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID },
					);
				} else if (task.input.on !== undefined && task.input.on.length > 0) {
					// A join with nothing left to delegate: no more work, so hand the last turn to the human.
					await tx.createTask(
						KeyTask,
						{ prompt: result, human: true },
						{ ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID },
					);
				}
				// A worker with nothing to emit is simply done; the orchestrator that emitted it holds its join.
				return { status: "terminal", outcome: { status: "completed", result } };
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

/** Every worker this context emitted, in creation order — the durable record the join is built from. */
async function emittedBy(
	tx: Tx,
	emitter: TaskId,
	call?: string,
): Promise<readonly TaskId<string>[]> {
	const found: TaskId<string>[] = [];
	let cursor: Cursor | undefined;
	for (;;) {
		const page = await tx.scanTasks(
			{ conversationId: ROOT_CONVERSATION_ID, kind: KeyTask.definition.name },
			256,
			cursor,
		);
		for (const record of page.items) {
			const input = record.input as unknown as KeyTaskInput;
			if (input.emission?.emitter !== emitter) continue;
			if (call !== undefined && input.emission.call !== call) continue;
			found.push(record.id as TaskId<string>);
		}
		if (page.next === undefined) break;
		cursor = page.next;
	}
	return found;
}

/**
 * The only verb a context uses: one piece of work per call. Call it more than once in a turn for
 * parallel work. A join over every worker emitted so far is minted when this context ends.
 */
export const Emit = defineTool({
	name: "emit",
	description:
		"Emit one worker context: a fresh context that runs the given task. You do not wait for it. Call emit once per piece of work; make several calls in the same turn for parallel work. When your turn ends, a join waiting on every worker you emitted is created with your last message as its prompt.",
	parameters: Type.Object({
		prompt: Type.String({ description: "The task for the worker context." }),
	}),
	replay: "safe",
	execute: async (args, api, context) => {
		const id = await api.commit(async (tx) => {
			const [existing] = await emittedBy(tx, api.taskId, api.callId);
			if (existing !== undefined) return existing;
			return tx.createTask(
				KeyTask,
				{ prompt: args.prompt, emission: { emitter: api.taskId, call: api.callId } },
				{ ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID },
			);
		}, context);
		return { output: [{ type: "text", text: `Emitted #${id}.` }] };
	},
});

export const KeySystem = defineExtension({
	name: "key",
	tasks: [KeyTask],
	tools: [Emit],
});
