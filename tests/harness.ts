// Test support in durable's own shape: a setup of host-lifetime objects, a function that opens one
// Harness from it, and small free helpers beside them. The API under test is called at the call site.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	type FauxProviderHandle,
	fauxProvider,
	type Models,
} from "@earendil-works/pi-ai";
import {
	type ConversationId,
	createRegistry,
	type EntryRecord,
	Harness,
	type Registry,
	type Storage,
	type TaskId,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { expect, vi } from "vitest";
import { Agents } from "../src/agents.ts";
import { KeySystem, KeyTask, type KeyTaskInput } from "../src/system.ts";
import { FakeGitEnv } from "./git.ts";

const context = BACKGROUND_CONTEXT;

/** The faux provider's default model, the one every conversation here runs. */
export const MODEL = { provider: "faux", modelId: "faux-1" } as const;

/** What a host process carries across a restart: its provider, models, registry, and reports. */
export type KeySetup = {
	readonly faux: FauxProviderHandle;
	readonly models: Models;
	readonly registry: Registry;
	readonly reports: unknown[];
};

export function keySetup(): KeySetup {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(KeySystem);
	registry.install(Agents);
	return { faux, models, registry, reports: [] };
}

/** Open one host process's Harness over `storage`; closing it and opening another on the same setup is a restart. */
export function openKey(
	storage: Storage,
	setup: KeySetup,
	env: FakeGitEnv = new FakeGitEnv(),
): Promise<Harness> {
	return Harness.open(
		storage,
		{
			models: setup.models,
			registry: setup.registry,
			env: () => env,
			onReport: (error) => setup.reports.push(error),
		},
		context,
	);
}

export type KeyRecord = TaskRecord<KeyTaskInput, unknown, string>;

/** Every key.task committed so far, in ID order: the whole cascade, terminal contexts included. */
export async function cascade(harness: Harness): Promise<readonly KeyRecord[]> {
	const records: KeyRecord[] = [];
	await harness.commit(async (tx) => {
		const page = await tx.scanTasks({ kind: KeyTask.definition.name }, 256);
		records.push(...(page.items as unknown as KeyRecord[]));
	}, context);
	return records;
}

/** The conversation a context minted for its own run, once it has. */
export async function conversationOf(harness: Harness, task: TaskId): Promise<ConversationId> {
	let found: ConversationId | undefined;
	await vi.waitFor(
		async () => {
			const { items } = await harness.commit((tx) => tx.scanConversations({}, 1000), context);
			found = items.find((item) => item.owner?.taskId === task)?.id;
			expect(found).toBeDefined();
		},
		{ interval: 5 },
	);
	return found as ConversationId;
}

/** The entries a conversation holds, in order. */
export async function entries(
	harness: Harness,
	id: ConversationId,
): Promise<readonly EntryRecord[]> {
	const conversation = await harness.conversation(id, context);
	if (conversation === undefined) throw new Error(`no conversation #${id}`);
	return (await conversation.context(context)).entries;
}
