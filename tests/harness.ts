// Test support in durable's own shape: a setup of host-lifetime objects, a function that opens one
// Harness from it, and small free helpers beside them. The API under test is called at the call site.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  type FauxProviderHandle,
  type FauxResponseStep,
  fauxProvider,
  type Message,
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
import { Fetch } from "../src/fetch.ts";
import { ModelDefaultsDoc } from "../src/models.ts";
import { Search } from "../src/search.ts";
import { CONVERSATION_TASK, type ConversationTaskInput, keySystem } from "../src/system.ts";
import { FakeEnv, fakeGit } from "./git.ts";

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
  registry.install(keySystem(fakeGit));
  registry.install(Search);
  registry.install(Fetch);
  registry.install(Agents);
  return { faux, models, registry, reports: [] };
}

export { CONVERSATION_TASK };

/** Open one host process's Harness over `storage`; closing it and opening another on the same setup is a restart. */
export async function openKey(
  storage: Storage,
  setup: KeySetup,
  env: FakeEnv = new FakeEnv(),
): Promise<Harness> {
  const harness = await Harness.open(
    storage,
    {
      models: setup.models,
      registry: setup.registry,
      env: () => env,
      onReport: (error) => setup.reports.push(error),
    },
    context,
  );
  // Every cascade child runs the faux model, as a host whose defaults are set does.
  await harness.commit(async (tx) => {
    (await tx.doc(ModelDefaultsDoc)).child = { ...MODEL };
  }, context);
  return harness;
}

export type ConversationTaskRecord = TaskRecord<ConversationTaskInput, unknown, string>;

/** Every conversation task committed so far, in ID order. */
export async function cascade(harness: Harness): Promise<readonly ConversationTaskRecord[]> {
  const records: ConversationTaskRecord[] = [];
  await harness.commit(async (tx) => {
    const page = await tx.scanTasks({ kind: CONVERSATION_TASK }, 256);
    records.push(...(page.items as unknown as ConversationTaskRecord[]));
  }, context);
  return records;
}

/** The conversation a child or successor task owns. */
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

/** Interrupt a task as the host does: abort the current work of its conversation. */
export async function interrupt(harness: Harness, task: TaskId): Promise<void> {
  const conversation = await harness.conversation(await conversationOf(harness, task), context);
  if (conversation === undefined) throw new Error(`no conversation of task ${task}`);
  await conversation.abort(context);
}

/** All user text in a model request, used to route concurrent conversations in a scripted model. */
export function requestText(messages: readonly Message[]): string {
  return messages
    .flatMap((message) => {
      if (message.role !== "user") return [];
      if (typeof message.content === "string") return [message.content];
      return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
    })
    .join("\n");
}

/** Answer the parent with one script and any conversation whose prompt contains a key with another. */
export function route(
  parent: FauxResponseStep,
  children: Readonly<Record<string, FauxResponseStep>>,
): FauxResponseStep {
  return (request, options, state, model) => {
    const text = requestText(request.messages);
    const key = Object.keys(children).find((candidate) => text.includes(candidate));
    const step = key === undefined ? parent : children[key];
    return typeof step === "function" ? step(request, options, state, model) : step;
  };
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
