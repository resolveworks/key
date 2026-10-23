// The host: one process owns the Session on SQLite and serves the transcripts over HTTP+SSE.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  AgentDoc,
  type ConversationId,
  type Cursor,
  configure,
  createRegistry,
  type Extension,
  Harness,
  type Storage,
  type TaskGraph,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { type ServerType, serve } from "@hono/node-server";
import type { Hono } from "hono";
import { Agents } from "./agents.ts";
import { api } from "./api.ts";
import type { Stats } from "./footer.ts";
import { git } from "./git.ts";
import { type KeyTaskInput, keySystem, keyTask } from "./system.ts";

/** The host's key, its git bound to the real one. */
const KeySystem = keySystem(git);
const KeyTask = keyTask(git);

const context = BACKGROUND_CONTEXT;
const SCAN_PAGE_SIZE = 256;

/** The port `key serve` binds; the client and a plain `new Host()` agree on it. */
export const PORT = 7317;
/** Everything the host owns lives here, outside every project: store, env. */
const dataDirectory = join(homedir(), ".key");
const MODEL = { provider: "deepseek", modelId: "deepseek-flash" };

/** What the host runs on. `new Host()` is one box: deepseek on SQLite at `PORT`. */
export type HostOptions = {
  readonly models: () => Models;
  readonly storage: () => Storage | Promise<Storage>;
  readonly extensions: readonly Extension[];
  readonly port: number;
};

const production = (): HostOptions => ({
  models: () => builtinModels(),
  storage: async () => {
    mkdirSync(dataDirectory, { recursive: true });
    return openNodeSqliteStorage(join(dataDirectory, "session.sqlite"));
  },
  extensions: [CodingTools, KeySystem, Agents],
  port: PORT,
});

/** One line in the transcript picker: a context's conversation, and whether it is running. */
export type Summary = {
  readonly id: number;
  /** That context's prompt. */
  readonly label: string;
  /** The directory that context runs in. */
  readonly cwd: string;
  readonly running: boolean;
  /** A forked context, or a terminated child: its story continues elsewhere. */
  readonly closed: boolean;
};

export class Host {
  #harness!: Harness;
  #prompts = new Map<number, string>();
  /** Each conversation's directory, by id: the cwd of its `pi.agent` document. */
  #agentCwds = new Map<number, string>();
  #summaries: readonly Summary[] = [];
  #graph: TaskGraph = { tasks: {} };
  /** Each conversation's owning task. */
  #owners = new Map<number, number | undefined>();
  /** Conversations a context minted children in. */
  #forked = new Set<number>();
  /** Task ids that are forked children, and those that have ended. */
  #children = new Set<number>();
  #ended = new Set<number>();
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
    return `http://127.0.0.1:${this.#port}`;
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

  /** What a view cannot say: the branch, the context window, the model. */
  stats(id: number): Promise<Stats> {
    return this.#statsOf(id);
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
      return this.#publish();
    });
  }

  /** Start a trajectory in a directory: one fresh context, in one commit, in a new conversation. */
  run(cwd: string, prompt: string): Promise<number> {
    return this.#harness.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, conversation.id, { model: MODEL, cwd });
      return tx.createTask(
        KeyTask,
        { prompt },
        {
          ownership: { kind: "conversation" },
          conversationId: conversation.id,
          background: true,
        },
      );
    }, context);
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
   * context task is background, so the abort cannot reach one — the interrupted context parks
   * without a terminus and whoever waits on it keeps waiting. */
  async interrupt(conversationId: number): Promise<void> {
    const id = conversationId as ConversationId;
    const conversation = await this.#harness.conversation(id, context);
    if (conversation === undefined) throw new Error(`no conversation #${conversationId}`);
    await conversation.abort(context);
  }

  #record(record: {
    readonly id: number;
    readonly kind: string;
    readonly conversationId: number;
    readonly input: unknown;
    readonly state: { readonly status: string };
  }): void {
    if (record.kind !== KeyTask.definition.name) return;
    const input = record.input as KeyTaskInput;
    this.#prompts.set(record.id, input.prompt);
    if ("name" in input) {
      this.#children.add(record.id);
      this.#forked.add(record.conversationId);
    }
    if (record.state.status === "completing" || record.state.status === "terminal")
      this.#ended.add(record.id);
  }

  /** A forked context lives on through its successors, a child through its branch. */
  #closed(conversationId: number): boolean {
    if (this.#forked.has(conversationId)) return true;
    const owner = this.#owners.get(conversationId);
    return owner !== undefined && this.#children.has(owner) && this.#ended.has(owner);
  }

  /** Recompute the transcript list and push it to every attached client. */
  async #publish(): Promise<void> {
    this.#summaries = await this.#summarise();
    for (const listener of this.#listeners) listener(this.#summaries);
  }

  async #summarise(): Promise<readonly Summary[]> {
    const conversations = await this.#scanConversations();
    // The graph holds live tasks only; a conversation runs while one belongs to it or owns it.
    const running = new Set<number>();
    for (const node of Object.values(this.#graph.tasks)) {
      running.add(node.conversationId);
      for (const owned of node.conversations) running.add(owned);
    }
    // Every context's conversation is owned by its task; an ownerless conversation is just a holder.
    for (const { id } of conversations) {
      const cwd = (await this.#harness.snapshot(AgentDoc, id as ConversationId, context))?.cwd;
      if (cwd !== undefined) this.#agentCwds.set(id, cwd);
    }
    return conversations
      .flatMap(({ id, owner }) =>
        owner === undefined
          ? []
          : [
              {
                id,
                label: this.#prompts.get(owner.taskId)?.split("\n", 1)[0]?.trim() ?? "",
                cwd: this.#agentCwds.get(id) ?? "",
                running: running.has(id),
                closed: this.#closed(id),
              },
            ],
      )
      .sort((a, b) => b.id - a.id);
  }

  async #scanConversations(): Promise<readonly { id: number; owner?: { taskId: number } }[]> {
    return this.#harness.commit(async (tx) => {
      const found: { id: number; owner?: { taskId: number } }[] = [];
      let cursor: Cursor | undefined;
      for (;;) {
        const page = await tx.scanConversations({}, SCAN_PAGE_SIZE, cursor);
        for (const record of page.items) {
          if (record.owner !== undefined) this.#owners.set(record.id, record.owner.taskId);
          found.push({
            id: record.id,
            ...(record.owner === undefined ? {} : { owner: { taskId: record.owner.taskId } }),
          });
        }
        if (page.next === undefined) break;
        cursor = page.next;
      }
      return found;
    }, context);
  }

  async listen(): Promise<void> {
    const bound = new Promise<{ port: number }>((resolve) => {
      this.#server = serve(
        { fetch: this.app.fetch, port: this.#options.port, hostname: "127.0.0.1" },
        ({ port }) => resolve({ port }),
      );
    });
    this.#port = (await bound).port;
    process.stdout.write(`key host on ${this.url}\n`);
    this.#harness.resume();
  }

  /** What the view cannot say: the branch its directory is on, and the window its model gives. */
  async #statsOf(id: number): Promise<Stats> {
    const agent = await this.#harness.snapshot(AgentDoc, id as ConversationId, context);
    const model = agent?.model ?? MODEL;
    const branch = await branchOf(agent?.cwd);
    return {
      ...(branch === undefined ? {} : { branch }),
      contextWindow:
        this.#options.models().getModel(model.provider, model.modelId)?.contextWindow ?? 0,
      model: model.modelId,
    };
  }

  async close(): Promise<void> {
    const closed = this.#server?.close() ?? Promise.resolve();
    await this.#harness.close(context);
    await closed;
  }
}

/** A working directory's branch, when it is a repository: the footer shows it beside the path. */
async function branchOf(cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined) return undefined;
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd)
    .then((stdout) => stdout.trim())
    .catch(() => "");
  return branch === "" ? undefined : branch;
}
