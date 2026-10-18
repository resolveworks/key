// The shared fixture: a real Harness over memory storage, a scripted model, and a git repository to work in.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Agents } from "../src/agents.ts";
import { KeySystem, KeyTask, type KeyTaskInput } from "../src/system.ts";

const context = BACKGROUND_CONTEXT;

/** The faux provider's default model, the one every conversation here runs. */
const MODEL: ModelRef = { provider: "faux", modelId: "faux-1" };

export type KeyFixture = {
	readonly faux: FauxProviderHandle;
	/** Script the model's answers in call order, recording each request in `requests`. */
	answer(steps: FauxResponseStep[]): void;
	readonly harness: Harness;
	readonly registry: Registry;
	/** The git repository the conversations work in; `cleanup()` deletes it. */
	readonly repo: string;
	/** Failures that did not fail a call, such as a throwing hook; a test fails on them. */
	readonly reports: unknown[];
	/** Every response the model asked for, in order: one per request, so a fork's round is scriptable. */
	readonly requests: TranscriptContext[];
	/** Every key.task committed so far, in ID order: the whole cascade, terminal contexts included. */
	run(prompt?: string): Promise<TaskId<string>>;
	cascade(): Promise<readonly KeyRecord[]>;
	/** Close the Harness, then fail the test on anything the run swallowed. */
	close(): Promise<void>;
	/** Remove the repository and whatever a child left in it. */
	cleanup(): void;
};

/**
 * Open a Key Harness in a fresh git repository, with the faux model answering. `storage` lets a test close
 * one Harness and open another on it, which is what a restart is.
 */
export async function openKey(
	storage: () => Storage = () => new MemoryStorage(),
): Promise<KeyFixture> {
	const requests: TranscriptContext[] = [];
	const faux = fauxProvider();
	// Script through one wrapper, so every request is on record and `script` stays call-order simple.
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

	const dir = mkdtempSync(join(tmpdir(), "key-"));
	const repo = join(dir, "repo");
	initRepo(repo);
	const env = new NodeExecutionEnv({ cwd: repo });
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
			await configure(tx, conversation.id, { model: MODEL, cwd: repo });
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
		repo,
		reports,
		requests,
		run,
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
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

export type KeyRecord = TaskRecord<KeyTaskInput, unknown, string>;

/**
 * Script the model's answers, in order, one per request. A context that forks asks once more after its
 * tool round, so script that round's answer too: `turn(answer, [name])`, `turn(text)`.
 */
export function script(key: KeyFixture, ...steps: FauxResponseStep[]): void {
	key.answer(steps);
}

/** A turn held open until the test opens it, so a test can act while a context is mid-run. */
export function gate(): { readonly held: () => Promise<void>; readonly open: () => void } {
	let open!: () => void;
	const held = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { held: () => held, open: () => open() };
}

/** Wait for a context to settle; its receipt, whose `outcome` holds the result. */
export function settled(harness: Harness, id: TaskId<string>): Promise<SettledTask<string>> {
	return harness.waitForTask(id, context);
}

export type WorktreeEntry = {
	/** Absolute path of the checkout. */
	readonly path: string;
	readonly head?: string;
	/** Branch name, without `refs/heads/`. */
	readonly branch?: string;
	readonly bare: boolean;
	readonly detached: boolean;
};

/** Every worktree git knows about, as `git worktree list --porcelain` reports them. */
export function gitWorktrees(repo: string): readonly WorktreeEntry[] {
	return git(repo, ["worktree", "list", "--porcelain"])
		.split("\n\n")
		.filter((block) => block.trim() !== "")
		.map((block) => {
			const fields = block.split("\n").map((line) => line.split(" ", 2));
			const field = (name: string): string | undefined => fields.find(([key]) => key === name)?.[1];
			return {
				path: field("worktree") as string,
				head: field("HEAD"),
				branch: field("branch")?.replace(/^refs\/heads\//, ""),
				bare: fields.some(([key]) => key === "bare"),
				detached: fields.some(([key]) => key === "detached"),
			};
		});
}

/** Poll `check` in real time until it holds; for waits that span commits and timers. */
export async function waitFor(
	check: () => boolean | Promise<boolean>,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("Condition was not reached");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** A repository with one commit on its default branch. */
function initRepo(repo: string): void {
	execFileSync("git", ["init", "--quiet", repo]);
	git(repo, ["config", "user.email", "key@example.com"]);
	git(repo, ["config", "user.name", "Key Test"]);
	writeFileSync(join(repo, "README.md"), "# key\n");
	git(repo, ["add", "README.md"]);
	git(repo, ["commit", "--quiet", "-m", "initial"]);
}

function git(repo: string, args: readonly string[]): string {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

export { fauxAssistantMessage, fauxText, fauxToolCall };
