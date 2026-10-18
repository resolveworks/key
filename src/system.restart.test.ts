// A restart is the crash-recovery path: a new Harness on the same storage takes up the run the first one
// left, and nothing it already committed happens twice.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	type FauxProviderHandle,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Models,
} from "@earendil-works/pi-ai";
import {
	type ConversationId,
	configure,
	createRegistry,
	Harness,
	MemoryStorage,
	type Registry,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeGitEnv, REPO } from "../tests/git.ts";
import { KeySystem, KeyTask } from "./system.ts";

const MODEL = { provider: "faux", modelId: "faux-1" };

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

/** What a host process carries across its restart: its provider, models, and registry. */
type Host = {
	readonly faux: FauxProviderHandle;
	readonly models: Models;
	readonly registry: Registry;
};

function host(): Host {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(KeySystem);
	return { faux, models, registry };
}

const opened: Harness[] = [];

afterEach(async () => {
	for (const harness of opened.splice(0)) await harness.close(BACKGROUND_CONTEXT);
});

/** One host process: a Harness over `storage`, with the host's models and registry. */
async function open(
	storage: Storage,
	{ models, registry }: Host,
	env: FakeGitEnv,
): Promise<Harness> {
	const harness = await Harness.open(
		storage,
		{ models, registry, env: () => env },
		BACKGROUND_CONTEXT,
	);
	opened.push(harness);
	return harness;
}

async function restart(storage: ReopenableStorage, harness: Harness, setup: Host, env: FakeGitEnv) {
	await harness.close(BACKGROUND_CONTEXT);
	opened.splice(opened.indexOf(harness), 1);
	storage.reopen();
	return open(storage, setup, env);
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

const scanTasks = (harness: Harness) =>
	harness.commit(async (tx) => (await tx.scanTasks({}, 100)).items, BACKGROUND_CONTEXT);

const scanConversations = (harness: Harness) =>
	harness.commit(async (tx) => (await tx.scanConversations({}, 100)).items, BACKGROUND_CONTEXT);

const contexts = async (harness: Harness) =>
	(await scanTasks(harness)).filter((record) => record.kind === KeyTask.definition.name);

/** The name a context was forked with; absent for an original context and the successor after it. */
const nameOf = (record: { readonly input: unknown }) =>
	(record.input as { readonly name?: string }).name;

/** The conversation holding the context's run: the one it created for itself. */
async function runConversation(harness: Harness, task: TaskId): Promise<ConversationId> {
	const found = (await scanConversations(harness)).find((record) => record.owner?.taskId === task);
	if (found === undefined) throw new Error(`context #${task} never started its conversation`);
	return found.id;
}

async function entriesOf(harness: Harness, id: ConversationId) {
	const conversation = await harness.conversation(id, BACKGROUND_CONTEXT);
	if (conversation === undefined) throw new Error(`no conversation #${id}`);
	return (await conversation.context(BACKGROUND_CONTEXT)).entries;
}

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
	}, BACKGROUND_CONTEXT);
}

/** The entries a run committed before the process died, mid-request: the prompt, unanswered. */
async function crashedMidRun(harness: Harness, task: TaskId): Promise<ConversationId> {
	const conversation = await runConversation(harness, task);
	expect((await entriesOf(harness, conversation)).map((entry) => entry.kind)).toEqual([
		"pi.user",
		"pi.system",
	]);
	return conversation;
}

describe("restart", () => {
	it("recovers a running context without duplicating work", async () => {
		const setup = host();
		const env = new FakeGitEnv();
		const storage = new ReopenableStorage();
		const first = await open(storage, setup, env);
		const busy = unanswered();
		setup.faux.setResponses([busy.step]);
		const { task } = await run(first, "write the report");
		first.resume();
		await busy.reached;
		const conversation = await crashedMidRun(first, task);
		const calls = setup.faux.state.callCount;

		// The crashed process never saw an answer, so the restart asks exactly once more.
		const second = await restart(storage, first, setup, env);
		setup.faux.setResponses([fauxAssistantMessage("the report")]);
		second.resume();
		await second.waitForTask(task, BACKGROUND_CONTEXT);
		expect((await second.getTask(task, BACKGROUND_CONTEXT))?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "completed", result: "the report" },
		});
		const entries = await entriesOf(second, conversation);
		expect(entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.system", "pi.assistant"]);
		expect(
			entries.filter((entry) => entry.model?.some((message) => message.role === "assistant")),
		).toHaveLength(1);
		expect(setup.faux.state.callCount - calls).toBe(1);
	});

	it("a context that saved its conversation id reuses that conversation after a restart", async () => {
		const setup = host();
		const env = new FakeGitEnv();
		const storage = new ReopenableStorage();
		const first = await open(storage, setup, env);
		const busy = unanswered();
		setup.faux.setResponses([busy.step]);
		const { task } = await run(first, "write the report");
		first.resume();
		await busy.reached;
		const conversation = await crashedMidRun(first, task);
		const before = await scanConversations(first);

		const second = await restart(storage, first, setup, env);
		setup.faux.setResponses([fauxAssistantMessage("the report")]);
		second.resume();
		await second.waitForTask(task, BACKGROUND_CONTEXT);
		expect(await scanConversations(second)).toEqual(before);
		// The prompt from the crashed attempt stayed: the restarted run answered in place, not in a new one.
		expect((await entriesOf(second, conversation)).map((entry) => entry.kind)).toEqual([
			"pi.user",
			"pi.system",
			"pi.assistant",
		]);
	});

	it("fork calls made before a crash still mint their children exactly once", async () => {
		const setup = host();
		const env = new FakeGitEnv();
		const storage = new ReopenableStorage();
		const first = await open(storage, setup, env);
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
		await first.waitForTask(task, BACKGROUND_CONTEXT);
		const minted = await contexts(first);
		expect(minted.filter((record) => nameOf(record) !== undefined).map(nameOf)).toEqual([
			"kid-a",
			"kid-b",
		]);

		const second = await restart(storage, first, setup, env);
		setup.faux.setResponses([
			fauxAssistantMessage("child a done"),
			fauxAssistantMessage("child b done"),
			fauxAssistantMessage("successor done"),
		]);
		second.resume();
		// The children run in their worktrees, then the successor runs on their results and ends.
		await vi.waitFor(async () => {
			const after = await contexts(second);
			expect(after).toHaveLength(minted.length);
			for (const record of after) expect(record.state.status).toBe("terminal");
		});
		const after = await contexts(second);
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
