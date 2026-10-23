// Test support in durable's own shape: a setup of host-lifetime objects, a function that opens one
// Harness from it, and small free helpers beside them. The API under test is called at the call site.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  type FauxProviderHandle,
  type FauxResponseStep,
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
import { type KeyTaskInput, keySystem } from "../src/system.ts";
import { FakeEnv, fakeGit } from "./git.ts";

const context = BACKGROUND_CONTEXT;

/** The key of the fake git: one definition of its task, installed by every setup here. */
const key = keySystem(fakeGit);

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
  registry.install(key.extension);
  registry.install(Agents);
  return { faux, models, registry, reports: [] };
}

/** The key.task of the fake git: the kind tests create, behavior resolved from the installed key. */
export const KeyTask = key.task;

/** Open one host process's Harness over `storage`; closing it and opening another on the same setup is a restart. */
export function openKey(
  storage: Storage,
  setup: KeySetup,
  env: FakeEnv = new FakeEnv(),
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

/** Interrupt a context as the host does: abort the current work of its conversation. */
export async function interrupt(harness: Harness, task: TaskId): Promise<void> {
  const conversation = await harness.conversation(await conversationOf(harness, task), context);
  if (conversation === undefined) throw new Error(`no conversation of task ${task}`);
  await conversation.abort(context);
}

/** A faux response that never answers: the run stays mid-generation until its request is aborted. */
export function unanswered(): { readonly step: FauxResponseStep; readonly reached: Promise<void> } {
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
