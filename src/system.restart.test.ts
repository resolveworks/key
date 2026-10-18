// A restart is the crash-recovery path: a new Harness on the same storage takes up the run the first one
// left, and nothing it already committed happens twice.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	configure,
	type Harness,
	MemoryStorage,
	type TaskId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEnv, REPO } from "../tests/git.ts";
import { conversationOf, entries, KeyTask, keySetup, MODEL, openKey } from "../tests/harness.ts";

const context = BACKGROUND_CONTEXT;

/**
 * In-memory storage a second Harness can open again: the records outlive the Session that wrote them,
 * so closing and reopening here is a process restart rather than a reset.
 */
class ReopenableStorage extends MemoryStorage {
	reopen(): this {
		(this as unknown as { closed: boolean }).closed = false;
		return this;
	}
}

const opened: Harness[] = [];

afterEach(async () => {
	for (const harness of opened.splice(0)) await harness.close(context);
});

/** Close one host process and start its replacement on the same storage: that is a restart. */
async function restart(
	storage: ReopenableStorage,
	harness: Harness,
	setup: ReturnType<typeof keySetup>,
	env: FakeEnv,
) {
	await harness.close(context);
	opened.splice(opened.indexOf(harness), 1);
	storage.reopen();
	return openKey(storage, setup, env);
}

/** A faux response that never answers: the run stays mid-generation until the harness cancels it. */
function unanswered(): { readonly step: FauxResponseStep; readonly reached: Promise<void> } {
	let reached!: () => void;
	const arrived = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const step: FauxResponseStep = (_context, options) =>
		new Promise((_resolve, reject) => {
			reached();
			const signal = options?.signal;
			if (signal === undefined) throw new Error("faux: the request has no abort signal");
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	return { step, reached: arrived };
}

const contexts = async (harness: Harness) =>
	(await harness.commit(async (tx) => (await tx.scanTasks({}, 100)).items, context)).filter(
		(record) => record.kind === KeyTask.definition.name,
	);

/** The name a context was forked with; absent for an original context and the successor after it. */
const nameOf = (record: { readonly input: unknown }) =>
	(record.input as { readonly name?: string }).name;

/** Start one context, with a conversation of its own, as the host does for a fresh prompt. */
async function run(
	harness: Harness,
	prompt: string,
): Promise<{ readonly task: TaskId; readonly conversation: ConversationId }> {
	return harness.commit(async (tx) => {
		const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
		await configure(tx, conversation.id, { model: MODEL, cwd: REPO });
		const task = await tx.createTask(
			KeyTask,
			{ prompt },
			{ ownership: { kind: "conversation" }, conversationId: conversation.id },
		);
		return { task, conversation: conversation.id };
	}, context);
}

/** The entries a run committed before the process died, mid-request: the prompt, unanswered. */
async function crashedMidRun(harness: Harness, task: TaskId) {
	const conversation = await conversationOf(harness, task);
	expect((await entries(harness, conversation)).map((entry) => entry.kind)).toEqual([
		"pi.user",
		"pi.system",
	]);
	return conversation;
}

describe("restart", () => {
	it("a context that saved its conversation id reuses that conversation after a restart", async () => {
		const setup = keySetup();
		const env = new FakeEnv();
		const storage = new ReopenableStorage();
		const first = await openKey(storage, setup, env);
		opened.push(first);
		const busy = unanswered();
		setup.faux.setResponses([busy.step]);
		const { task } = await run(first, "write the report");
		first.resume();
		await busy.reached;
		const conversation = await crashedMidRun(first, task);
		const before = await first.commit(
			async (tx) => (await tx.scanConversations({}, 100)).items,
			context,
		);

		const second = await restart(storage, first, setup, env);
		opened.push(second);
		setup.faux.setResponses([fauxAssistantMessage("the report")]);
		second.resume();
		await second.waitForTask(task, context);
		const after = await second.commit(
			async (tx) => (await tx.scanConversations({}, 100)).items,
			context,
		);
		expect(after).toEqual(before);
		// The prompt from the crashed attempt stayed: the restarted run answered in place, not in a new one.
		expect((await entries(second, conversation)).map((entry) => entry.kind)).toEqual([
			"pi.user",
			"pi.system",
			"pi.assistant",
		]);
	});

	it("fork calls made before a crash still mint their children exactly once", async () => {
		const setup = keySetup();
		const env = new FakeEnv();
		const storage = new ReopenableStorage();
		const first = await openKey(storage, setup, env);
		opened.push(first);
		setup.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("fork", { name: "kid-a", prompt: "do a" }, { id: "call-a" }),
					fauxToolCall("fork", { name: "kid-b", prompt: "do b" }, { id: "call-b" }),
				],
				{ stopReason: "toolUse" },
			),
			// The context ends by minting its children: this is the last response the first process saw.
			fauxAssistantMessage("forked"),
		]);
		const { task } = await run(first, "split the work");
		first.resume();
		await first.waitForTask(task, context);
		const minted = await contexts(first);
		expect(minted.filter((record) => nameOf(record) !== undefined).map(nameOf)).toEqual([
			"kid-a",
			"kid-b",
		]);

		const second = await restart(storage, first, setup, env);
		opened.push(second);
		setup.faux.setResponses([
			fauxAssistantMessage("child a done"),
			fauxAssistantMessage("child b done"),
			fauxAssistantMessage("successor done"),
		]);
		second.resume();
		// The children run in their worktrees, then the successor runs on their results and ends.
		const after = await vi.waitFor(async () => {
			const current = await contexts(second);
			expect(current).toHaveLength(minted.length);
			for (const record of current) expect(record.state.status).toBe("terminal");
			return current;
		});
		expect(after.map((record) => record.id).sort()).toEqual(
			minted.map((record) => record.id).sort(),
		);
		const children = after.filter((record) => (record.input as { child?: true }).child === true);
		expect(children.map(nameOf)).toEqual(["kid-a", "kid-b"]);
		const successors = after.filter(
			(record) => (record.input as { on?: unknown }).on !== undefined,
		);
		expect(successors).toHaveLength(1);
		expect(successors[0]?.input).toMatchObject({
			prompt: "forked",
			on: children.map((record) => record.id),
		});
	});
});
