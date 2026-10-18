// The shared fixture: a real Harness over memory storage, a scripted model, and a fake git to work over.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	type FauxProviderHandle,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	type Cursor,
	configure,
	createRegistry,
	Harness,
	MemoryStorage,
	type ModelRef,
	type Registry,
	type SettledTask,
	type Storage,
	type TaskId,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Agents } from "../src/agents.ts";
import { KeySystem, KeyTask, type KeyTaskInput } from "../src/system.ts";
import { FakeGitEnv } from "./git.ts";

const context = BACKGROUND_CONTEXT;

/** The faux provider's default model, the one every conversation here runs. */
const MODEL: ModelRef = { provider: "faux", modelId: "faux-1" };

export type KeyFixture = {
	readonly faux: FauxProviderHandle;
	/** Script the model's answers in call order, recording each request in `requests`. */
	answer(steps: FauxResponseStep[]): void;
	readonly harness: Harness;
	readonly registry: Registry;
	/** Every response the model asked for, in order: one per request, so a fork's round is scriptable. */
	readonly requests: TranscriptContext[];
	/** Every key.task committed so far, in ID order: the whole cascade, terminal contexts included. */
	run(prompt?: string): Promise<TaskId<string>>;
	/** Wait for a context to settle; its receipt, whose `outcome` holds the result. */
	settled(id: TaskId<string>): Promise<SettledTask<string>>;
	cascade(): Promise<readonly KeyRecord[]>;
	/** Close the Harness, then fail the test on anything the run swallowed. */
	close(): Promise<void>;
};

/**
 * Open a Key Harness on the faux model, with fake git underneath. `storage` lets a test close one
 * Harness and open another on it, which is what a restart is.
 */
export async function openKey(
	storage: () => Storage = () => new MemoryStorage(),
): Promise<KeyFixture> {
	const requests: TranscriptContext[] = [];
	const faux = fauxProvider();
	// Script through one wrapper, so every request is on record and `answer` stays call-order simple.
	const answer = (steps: FauxResponseStep[]) =>
		faux.setResponses(
			steps.map((step) =>
				typeof step === "function"
					? (context, ...rest) => {
							requests.push(context);
							return step(context, ...rest);
						}
					: (context) => {
							requests.push(context);
							return step;
						},
			),
		);
	const models = createModels();
	models.setProvider(faux.provider);

	const env = new FakeGitEnv();
	const registry: Registry = createRegistry();
	registry.install(CodingTools);
	registry.install(KeySystem);
	registry.install(Agents);

	const reports: unknown[] = [];
	const harness = await Harness.open(
		storage(),
		{ models, registry, env: () => env, onReport: (error) => reports.push(error) },
		context,
	);

	// What `Host.run()` writes: one fresh context, in one commit, in a new conversation with the model and cwd set.
	async function run(prompt = "do the task"): Promise<TaskId<string>> {
		const task = await harness.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			await configure(tx, conversation.id, { model: MODEL, cwd: env.cwd });
			return tx.createTask(
				KeyTask,
				{ prompt },
				{ ownership: { kind: "conversation" }, conversationId: conversation.id },
			);
		}, context);
		// Scheduling is off until asked: asking starts the context the commit just made.
		harness.resume();
		return task;
	}

	return {
		faux,
		answer,
		harness,
		registry,
		requests,
		run,
		settled: (id) => harness.waitForTask(id, context),
		cascade: async () => {
			const records: KeyRecord[] = [];
			await harness.commit(async (tx) => {
				let cursor: Cursor | undefined;
				for (;;) {
					const page = await tx.scanTasks({ kind: KeyTask.definition.name }, 256, cursor);
					records.push(...(page.items as unknown as KeyRecord[]));
					if (page.next === undefined) return;
					cursor = page.next;
				}
			}, context);
			return records;
		},
		// A throwing hook, or an event nobody awaits, is how a broken run hides; it fails here instead.
		close: () =>
			harness.close(context).finally(() => {
				if (reports.length > 0) throw new Error(`harness reported failures: ${reports.join("\n")}`);
			}),
	};
}

export type KeyRecord = TaskRecord<KeyTaskInput, unknown, string>;

export { fauxAssistantMessage, fauxText, fauxToolCall };
