// The host: one process owns the Session on SQLite and serves the transcripts over HTTP+SSE.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  AgentDoc,
  type AgentState,
  type ConversationId,
  type ConversationView,
  type Cursor,
  configure,
  createRegistry,
  type Extension,
  Harness,
  type ModelRef,
  type Storage,
  type TaskGraph,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { type AutocompleteSuggestions, CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { type ServerType, serve } from "@hono/node-server";
import type { Hono } from "hono";
import { Agents } from "./agents.ts";
import { api } from "./api.ts";
import type { Stats } from "./footer.ts";
import { git } from "./git.ts";
import { Search } from "./search.ts";
import { type KeyTaskInput, keySystem } from "./system.ts";

/** The host's key, its git bound to the real one. */
const { extension: KeySystem, task: KeyTask } = keySystem(git);

const context = BACKGROUND_CONTEXT;
const SCAN_PAGE_SIZE = 256;

/** The port `key serve` binds; the client and a plain `new Host()` agree on it. */
export const PORT = 7317;
/** Everything the host owns lives here, outside every project: store, env. */
const dataDirectory = join(homedir(), ".key");
/** What the host runs on: `KEY_MODEL` as `provider/model`, split at the first slash — the id may carry
 * its own (openrouter). */
function parseModel(text: string): ModelRef {
  const slash = text.indexOf("/");
  const provider = text.slice(0, slash);
  const modelId = text.slice(slash + 1);
  if (slash < 0 || provider === "" || modelId === "")
    throw new Error(`KEY_MODEL must be "provider/model": "${text}"`);
  return { provider, modelId };
}

/** What the host runs on. `new Host()` is one box: `KEY_MODEL` on SQLite at `PORT`. */
export type HostOptions = {
  readonly models: () => Models;
  /** The model a new conversation runs: the host's env, or its own. */
  readonly model: () => ModelRef;
  readonly storage: () => Storage | Promise<Storage>;
  readonly extensions: readonly Extension[];
  readonly port: number;
  /** The interface the server listens on: `KEY_BIND`, loopback by default. */
  readonly hostname: string;
  /** The level a new conversation runs at: the host's env, or its own. */
  readonly thinkingLevel: () => ModelThinkingLevel;
};

const production = (): HostOptions => ({
  models: () => builtinModels(),
  model: () => parseModel(process.env.KEY_MODEL ?? "deepseek/deepseek-flash"),
  storage: async () => {
    mkdirSync(dataDirectory, { recursive: true });
    return openNodeSqliteStorage(join(dataDirectory, "session.sqlite"));
  },
  extensions: [CodingTools, KeySystem, Search, Agents],
  port: PORT,
  hostname: process.env.KEY_BIND ?? "127.0.0.1",
  thinkingLevel: () => (process.env.KEY_THINKING_LEVEL ?? "high") as ModelThinkingLevel,
});

/** One line in the transcript picker: a context's conversation, and whether it is running. */
export type Summary = {
  readonly id: number;
  /** That context's prompt. */
  readonly label: string;
  /** The directory that context runs in. */
  readonly cwd: string;
  /** Steps in under the conversation whose context minted this one: 0 for a cascade's kickoff. */
  readonly depth: number;
  readonly running: boolean;
};

export class Host {
  #harness!: Harness;
  #prompts = new Map<number, string>();
  /** Every run waiting on its answer: each resolves when the graph shows its task's mint. */
  #mints = new Map<number, (conversation: number) => void>();
  #summaries: readonly Summary[] = [];
  #graph: TaskGraph = { tasks: {} };
  #server!: ServerType;
  #port!: number;
  #app?: Hono;
  #listeners = new Set<(summaries: readonly Summary[]) => void>();
  #options: HostOptions;

  constructor(options: HostOptions = production()) {
    this.#options = options;
  }

  /** The port the server bound: the configured one, or the one the kernel chose for port 0. */
  get port(): number {
    return this.#port;
  }

  get url(): string {
    return `http://${this.#options.hostname}:${this.#port}`;
  }

  /** The transcript list as it stands right now. */
  get summaries(): readonly Summary[] {
    return this.#summaries;
  }

  /** Subscribe to every later transcript list; the returned function unsubscribes. */
  onSummaries(listener: (summaries: readonly Summary[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** One conversation's live view, when the conversation exists. */
  async watch(id: number) {
    const conversation = await this.#harness.conversation(id as ConversationId, context);
    return conversation?.watch(context);
  }

  /** What a view cannot say: the branch, the context window, the model and its level. */
  async stats(view: ConversationView): Promise<Stats> {
    const agent = view.docs["pi.agent"] as AgentState | undefined;
    const ref = agent?.model ?? this.#options.model();
    const model = this.#options.models().getModel(ref.provider, ref.modelId);
    const branch = await branchOf(agent?.cwd);
    return {
      ...(branch === undefined ? {} : { branch }),
      contextWindow: model?.contextWindow ?? 0,
      model: ref.modelId,
      thinkingLevel: agent?.thinkingLevel ?? this.#options.thinkingLevel(),
    };
  }

  /** The host's HTTP surface, in-process: `app.request()` answers without a port. */
  get app(): Hono {
    this.#app ??= api(this);
    return this.#app;
  }

  /** Start task scheduling. Idempotent, so `listen` resumes again without harm. */
  resume(): void {
    this.#harness.resume();
  }

  async open(): Promise<void> {
    const registry = createRegistry();
    for (const extension of this.#options.extensions) registry.install(extension);
    this.#harness = await Harness.open(
      await this.#options.storage(),
      {
        models: this.#options.models(),
        registry,
        env: (target) => {
          // A conversation without a root is a bug to surface, not to paper over.
          if (target.cwd === undefined)
            throw new Error(`conversation ${target.conversationId} has no cwd`);
          return new NodeExecutionEnv({ cwd: target.cwd });
        },
        onReport: (error) => console.error("key:", error),
      },
      context,
    );

    // Prompts are not in the graph, so recover every key.task's input and then follow commits.
    await this.#harness.commit(async (tx) => {
      let cursor: Cursor | undefined;
      for (;;) {
        const page = await tx.scanTasks({ kind: KeyTask.definition.name }, SCAN_PAGE_SIZE, cursor);
        for (const record of page.items) this.#record(record);
        if (page.next === undefined) break;
        cursor = page.next;
      }
    }, context);

    this.#harness.subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (change.type === "task") this.#record(change.value);
      }
    });

    await this.#publish();
    const watch = await this.#harness.watchTaskGraph(context);
    watch.start((graph) => {
      this.#graph = graph;
      for (const [task, resolve] of this.#mints) {
        const conversation = graph.tasks[task]?.conversations.at(0);
        if (conversation !== undefined) {
          this.#mints.delete(task);
          resolve(conversation);
        }
      }
      return this.#publish();
    });
  }

  /** The prompt's path completions, answered from the host's own filesystem: the line as it stands
   * before the cursor, and whether the tab key forced the asking. */
  complete(
    cwd: string,
    text: string,
    force: boolean,
    signal: AbortSignal,
  ): Promise<AutocompleteSuggestions | null> {
    return new CombinedAutocompleteProvider([], cwd).getSuggestions([text], 0, text.length, {
      signal,
      force,
    });
  }

  /** Start a trajectory in a directory: one fresh context, in one commit, in a new conversation.
   * The commit makes only the trajectory's holder — the conversation that owns the kickoff task
   * and carries its config — while the context's own conversation is minted when the task runs;
   * the answer waits for that mint, for it is the conversation a client opens. */
  async run(cwd: string, prompt: string): Promise<number> {
    const task = await this.#harness.commit(async (tx) => {
      const holder = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, holder.id, {
        model: this.#options.model(),
        cwd,
        thinkingLevel: this.#options.thinkingLevel(),
      });
      return tx.createTask(
        KeyTask,
        { prompt },
        {
          ownership: { kind: "conversation" },
          conversationId: holder.id,
          background: true,
        },
      );
    }, context);
    const minted = this.#graph.tasks[task]?.conversations.at(0);
    if (minted !== undefined) return minted;
    return await new Promise((resolve) => this.#mints.set(task, resolve));
  }

  /** Message an existing context: one continuation context in its conversation, steering it when busy
   * and minting at its terminus like any other. */
  async continue(conversationId: number, prompt: string): Promise<void> {
    const id = conversationId as ConversationId;
    if ((await this.#harness.conversation(id, context)) === undefined)
      throw new Error(`no conversation #${conversationId}`);
    await this.#harness.commit(
      (tx) =>
        tx.createTask(
          KeyTask,
          { prompt, conversationId: id },
          { ownership: { kind: "conversation" }, conversationId: id, background: true },
        ),
      context,
    );
  }

  /** Interrupt a context: abort the current work of its conversation, and nothing else. Every
   * context task is background, so the abort cannot reach the task — the run observes it and
   * ends aborted. */
  async interrupt(conversationId: number): Promise<void> {
    const id = conversationId as ConversationId;
    const conversation = await this.#harness.conversation(id, context);
    if (conversation === undefined) throw new Error(`no conversation #${conversationId}`);
    await conversation.abort(context);
  }

  /** A prompt is not in the graph: the task records keep it, for the list to name a context by. */
  #record(record: { readonly id: number; readonly kind: string; readonly input: unknown }): void {
    if (record.kind === KeyTask.definition.name)
      this.#prompts.set(record.id, (record.input as KeyTaskInput).prompt);
  }

  /** Recompute the transcript list and push it to every attached client. */
  async #publish(): Promise<void> {
    this.#summaries = await this.#summarise();
    for (const listener of this.#listeners) listener(this.#summaries);
  }

  async #summarise(): Promise<readonly Summary[]> {
    // Every context's conversation is owned by its task; an ownerless conversation is just a holder.
    const listed = (await this.#scanConversations()).flatMap(({ id, owner }) =>
      owner === undefined ? [] : [{ id, owner }],
    );
    // The graph holds live tasks only; a conversation runs while one belongs to it or owns it.
    const running = this.#running();
    const cwds = new Map<number, string>();
    for (const { id } of listed) {
      const cwd = (await this.#harness.snapshot(AgentDoc, id as ConversationId, context))?.cwd;
      if (cwd !== undefined) cwds.set(id, cwd);
    }
    return forest(listed).map(({ id, owner, depth }) => ({
      id,
      label: this.#prompts.get(owner.taskId)?.split("\n", 1)[0]?.trim() ?? "",
      cwd: cwds.get(id) ?? "",
      depth,
      running: running.has(id),
    }));
  }

  async #scanConversations(): Promise<readonly { id: number; owner?: Creator }[]> {
    return this.#harness.commit(async (tx) => {
      const found: { id: number; owner?: Creator }[] = [];
      let cursor: Cursor | undefined;
      for (;;) {
        const page = await tx.scanConversations({}, SCAN_PAGE_SIZE, cursor);
        for (const record of page.items) found.push({ id: record.id, owner: record.owner });
        if (page.next === undefined) break;
        cursor = page.next;
      }
      return found;
    }, context);
  }

  async listen(): Promise<void> {
    const bound = new Promise<{ port: number }>((resolve) => {
      this.#server = serve(
        { fetch: this.app.fetch, port: this.#options.port, hostname: this.#options.hostname },
        ({ port }) => resolve({ port }),
      );
    });
    this.#port = (await bound).port;
    process.stdout.write(`key host on ${this.url}\n`);
    this.#harness.resume();
  }

  /** A conversation runs while a live task of it runs or waits: a waiting successor keeps the
   * chain live. A terminal task leaves the graph, so the dot goes hollow on its own. */
  #running(): ReadonlySet<number> {
    const running = new Set<number>();
    for (const node of Object.values(this.#graph.tasks)) {
      running.add(node.conversationId);
      for (const owned of node.conversations) running.add(owned);
    }
    return running;
  }

  async close(): Promise<void> {
    const closed = this.#server?.close() ?? Promise.resolve();
    await this.#harness.close(context);
    await closed;
  }
}

/** A conversation's creator edge, as durable records it at the mint: the context's task, in the
 * conversation that minted it. */
type Creator = { readonly taskId: number; readonly conversationId: number };

/** A conversation the list shows: a context's own. A conversation without a creator is the holder
 * `run` made for a kickoff, and the list skips it. */
type ContextConversation = { readonly id: number; readonly owner: Creator };

/** A listed conversation placed for display: `depth` hops under its cascade's kickoff. */
type Placed = ContextConversation & { depth: number };

/** The listed conversations in display order: one contiguous block per cascade — the tree rooted
 * at a kickoff, whose creator is the unlisted holder — the newest cascade's block first, and within
 * a block a conversation ahead of its children, siblings ascending by id, so the successor a
 * terminus mints after its forks lands last on its level. */
function forest(conversations: readonly ContextConversation[]): readonly Placed[] {
  const listed = new Set(conversations.map(({ id }) => id));
  const block = (root: ContextConversation, depth: number): readonly Placed[] => [
    { ...root, depth },
    ...conversations
      .filter(({ owner }) => owner.conversationId === root.id)
      .sort((left, right) => left.id - right.id)
      .flatMap((child) => block(child, depth + 1)),
  ];
  return conversations
    .filter(({ owner }) => !listed.has(owner.conversationId))
    .map((root) => block(root, 0))
    .sort(
      (left, right) =>
        Math.max(...right.map(({ id }) => id)) - Math.max(...left.map(({ id }) => id)),
    )
    .flat();
}

/** A working directory's branch, when it is a repository: the footer shows it beside the path. */
async function branchOf(cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined) return undefined;
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd)
    .then((stdout) => stdout.trim())
    .catch(() => "");
  return branch === "" ? undefined : branch;
}
