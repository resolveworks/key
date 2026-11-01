// The host: one process owns the Session on SQLite and serves the transcripts over HTTP+SSE.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AuthType,
  clampThinkingLevel,
  type Models,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
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
  type JsonObject,
  LiveDoc,
  type LiveState,
  type ModelRef,
  type Page,
  type SessionDocToken,
  type Storage,
  type TaskGraph,
  type TaskRecord,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { type AutocompleteSuggestions, CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { type ServerType, serve } from "@hono/node-server";
import type { Hono } from "hono";
import { Agents } from "./agents.ts";
import { api } from "./api.ts";
import { FileCredentialStore } from "./auth.ts";
import type { Target } from "./defaults.ts";
import { Fetch } from "./fetch.ts";
import type { Stats } from "./footer.ts";
import { git } from "./git.ts";
import { LoginSession, type ProviderInfo } from "./login.ts";
import { type ModelDefaults, ModelDefaultsDoc, type ModelInfo } from "./models.ts";
import { Search } from "./search.ts";
import { SeenDoc } from "./seen.ts";
import { KeyTask, type KeyTaskInput, keySystem } from "./system.ts";
import { DEFAULT_THINKING_LEVEL, type ThinkingDefaults, ThinkingDefaultsDoc } from "./thinking.ts";

/** The host's key, its git bound to the real one. */
const { extension: KeySystem } = keySystem(git);

const context = BACKGROUND_CONTEXT;
const SCAN_PAGE_SIZE = 256;

/** The port `key serve` binds; the client and a plain `new Host()` agree on it. */
export const PORT = 7317;
/** Everything the host owns lives here, outside every project: store, credentials. */
const dataDirectory = join(homedir(), ".key");

/** What the host runs on. `new Host()` is one box: defaults on the session at `PORT`. */
export type HostOptions = {
  readonly models: () => Models;
  readonly storage: () => Storage | Promise<Storage>;
  readonly extensions: readonly Extension[];
  readonly port: number;
  /** The interface the server listens on: `KEY_BIND`, loopback by default. */
  readonly hostname: string;
};

const production = (): HostOptions => {
  const models = builtinModels({
    credentials: new FileCredentialStore(join(dataDirectory, "auth.json")),
  });
  return {
    models: () => models,
    storage: async () => {
      mkdirSync(dataDirectory, { recursive: true });
      return openNodeSqliteStorage(join(dataDirectory, "session.sqlite"));
    },
    extensions: [CodingTools, KeySystem, Search, Fetch, Agents],
    port: PORT,
    hostname: process.env.KEY_BIND ?? "127.0.0.1",
  };
};

/** One line in the transcript picker: a conversation, whether it streams, and whether it needs a human. */
export type Summary = {
  readonly id: number;
  /** The prompt that started this conversation. */
  readonly label: string;
  /** The directory this conversation runs in. */
  readonly cwd: string;
  /** Steps below the conversation whose task created this one: 0 for a cascade's kickoff. */
  readonly depth: number;
  /** This conversation's own run is in flight. */
  readonly streaming: boolean;
  /** The cascade stopped here, the next move is the human's, and no one has looked since. */
  readonly attention: boolean;
};

export class Host {
  #harness!: Harness;
  #summaries: readonly Summary[] = [];
  #graph: TaskGraph = { tasks: {} };
  #server!: ServerType;
  #port!: number;
  #app?: Hono;
  #listeners = new Set<(summaries: readonly Summary[]) => void>();
  /** Conversations a client currently has open, by id: a stop that lands under a watch is seen. */
  #watchers = new Map<number, number>();
  #login?: LoginSession;
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

  /** One conversation's live view, when the conversation exists. Attaching one is a human
   * looking: the conversation's stop counts as seen, its mark retired. Stays counted while the
   * view is open, so a stop that lands meanwhile is seen too. */
  async watch(id: number) {
    const conversation = await this.#harness.conversation(id as ConversationId, context);
    if (conversation === undefined) return undefined;
    await this.#see(id);
    const watch = await conversation.watch(context);
    this.#watchers.set(id, (this.#watchers.get(id) ?? 0) + 1);
    void watch.closed.then(() => {
      const remaining = (this.#watchers.get(id) ?? 1) - 1;
      if (remaining === 0) this.#watchers.delete(id);
      else this.#watchers.set(id, remaining);
    });
    return watch;
  }

  /** The models of configured providers, and the two defaults `/model` edits. */
  async modelSettings(): Promise<{
    readonly defaults: ModelDefaults;
    readonly models: readonly ModelInfo[];
  }> {
    const [models, defaults] = await Promise.all([
      this.#options.models().getAvailable(),
      this.#stored(ModelDefaultsDoc),
    ]);
    return {
      defaults,
      models: models.map(({ provider, id, name, contextWindow }) => ({
        provider,
        id,
        name,
        contextWindow,
      })),
    };
  }

  /** The levels new conversations and their children run at: `/thinking`'s choices, else the
   * default. */
  async thinkingDefaults(): Promise<Required<ThinkingDefaults>> {
    const defaults = await this.#stored(ThinkingDefaultsDoc);
    return {
      conversation: defaults.conversation ?? DEFAULT_THINKING_LEVEL,
      child: defaults.child ?? DEFAULT_THINKING_LEVEL,
    };
  }

  /** Set one target's level; each conversation clamps it to what its model supports. */
  async setThinkingDefault(target: Target, level: ModelThinkingLevel): Promise<void> {
    await this.#harness.commit(async (tx) => {
      (await tx.doc(ThinkingDefaultsDoc))[target] = level;
    }, context);
  }

  /** Every provider `/login` can configure, with what it offers and whether it is set up. */
  async providers(): Promise<readonly ProviderInfo[]> {
    const models = this.#options.models();
    return Promise.all(
      [...models.getProviders()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (provider) => {
          const status = await models.checkAuth(provider.id);
          return {
            id: provider.id,
            name: provider.name,
            ...(provider.auth.apiKey === undefined
              ? {}
              : {
                  apiKey: {
                    name: provider.auth.apiKey.name,
                    login: provider.auth.apiKey.login !== undefined,
                  },
                }),
            ...(provider.auth.oauth === undefined
              ? {}
              : {
                  oauth: {
                    name: provider.auth.oauth.name,
                    ...(provider.auth.oauth.loginLabel === undefined
                      ? {}
                      : { label: provider.auth.oauth.loginLabel }),
                    login: true,
                    subscription: provider.auth.oauth.isSubscription === true,
                  },
                }),
            ...(status === undefined ? {} : { status }),
          };
        }),
    );
  }

  /** Begin a login the client follows; a new one cancels whatever was still waiting. */
  startLogin(providerId: string, type: AuthType): void {
    const models = this.#options.models();
    const provider = models.getProvider(providerId);
    if (provider === undefined) throw new Error(`unknown provider: ${providerId}`);
    const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
    if (method?.login === undefined)
      throw new Error(`${provider.name} does not support ${type} login`);
    this.#login?.abort();
    this.#login = new LoginSession(models, provider, type);
    this.#login.start();
  }

  /** The login the client is following, if any. */
  get login(): LoginSession | undefined {
    return this.#login;
  }

  /** Point one default at a catalog model; a request fails later if its provider has no key. */
  async setModelDefault(target: Target, ref: ModelRef): Promise<void> {
    if (this.#options.models().getModel(ref.provider, ref.modelId) === undefined)
      throw new Error(`unknown model: ${ref.provider}/${ref.modelId}`);
    await this.#harness.commit(async (tx) => {
      (await tx.doc(ModelDefaultsDoc))[target] = { ...ref };
    }, context);
  }

  /** What a view cannot say: the branch and the context window. */
  async stats(view: ConversationView): Promise<Stats> {
    const agent = view.docs["pi.agent"] as AgentState | undefined;
    const ref = agent?.model;
    if (ref === undefined) throw new Error(`conversation ${view.conversation.id} has no model`);
    const model = this.#options.models().getModel(ref.provider, ref.modelId);
    const branch = await branchOf(agent?.cwd);
    return {
      ...(branch === undefined ? {} : { branch }),
      contextWindow: model?.contextWindow ?? 0,
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
        // A task-owned conversation starts on the child default, not on a copy of its owner.
        conversationCreated: async (tx, conversation) => {
          if (conversation.owner === undefined) return;
          const child = (await tx.doc(ModelDefaultsDoc)).child;
          if (child === undefined) throw new Error("no child model default: set one with /model");
          const model = this.#model(child);
          const level = (await tx.doc(ThinkingDefaultsDoc)).child ?? DEFAULT_THINKING_LEVEL;
          await configure(tx, conversation.id, {
            model: child,
            thinkingLevel: clampThinkingLevel(model, level),
          });
        },
        onReport: (report) => console.error("key:", report),
      },
      context,
    );

    await this.#publish();
    const watch = await this.#harness.watchTaskGraph(context);
    watch.start(async (call) => {
      if (call.kind !== "value") return;
      this.#graph = call.value;
      await this.#publish();
    });
  }

  /** One catalog model, or the loud failure of a default that names none. */
  #model(ref: { readonly provider: string; readonly modelId: string }) {
    const model = this.#options.models().getModel(ref.provider, ref.modelId);
    if (model === undefined) throw new Error(`unknown model: ${ref.provider}/${ref.modelId}`);
    return model;
  }

  /** A document's stored value, exactly as its command left it, or what it starts as. */
  async #stored<T extends JsonObject>(doc: SessionDocToken<T>): Promise<T> {
    return (await this.#harness.snapshot(doc, context)) ?? doc.definition.initial();
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

  /** Start a cascade in a directory: an ownerless conversation and its first prompt. */
  async run(cwd: string, prompt: string): Promise<number> {
    const { conversation: ref } = await this.#stored(ModelDefaultsDoc);
    if (ref === undefined) throw new Error("no conversation model default: set one with /model");
    const { conversation: level } = await this.thinkingDefaults();
    const conversation = await this.#harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: ref,
          cwd,
          thinkingLevel: clampThinkingLevel(this.#model(ref), level),
        },
      },
      context,
    );
    await conversation.submit({ type: "input", content: prompt, whenBusy: "steer" }, context);
    return conversation.id;
  }

  /** Message a conversation directly, steering its current run when it is busy. */
  async continue(conversationId: number, prompt: string): Promise<void> {
    const id = conversationId as ConversationId;
    const conversation = await this.#harness.conversation(id, context);
    if (conversation === undefined) throw new Error(`no conversation #${conversationId}`);
    await conversation.submit({ type: "input", content: prompt, whenBusy: "steer" }, context);
  }

  /** Interrupt current work; background cascade tasks have their own conversations. */
  async interrupt(conversationId: number): Promise<void> {
    const id = conversationId as ConversationId;
    const conversation = await this.#harness.conversation(id, context);
    if (conversation === undefined) throw new Error(`no conversation #${conversationId}`);
    await conversation.abort(context);
  }

  /** Mark a conversation's stop seen, then publish: every list drops its mark at once. */
  async #see(id: number): Promise<void> {
    const added = await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(SeenDoc);
      if (doc.seen.includes(id)) return false;
      doc.seen.push(id);
      return true;
    }, context);
    if (added) await this.#publish();
  }

  /** Recompute the transcript list and push it to every attached client. */
  async #publish(): Promise<void> {
    this.#summaries = await this.#summarise();
    for (const listener of this.#listeners) listener(this.#summaries);
  }

  async #summarise(): Promise<readonly Summary[]> {
    const { conversations, runs } = await this.#scan();
    const owners = new Map(conversations.map(({ id, owner }) => [id, owner?.taskId]));
    // The graph holds live tasks only. Cascade liveness suppresses the final-frontier dot;
    // a blocked task is the one live state that needs the human now.
    const cascade = new Set<number>();
    const blocked = new Set<number>();
    for (const node of Object.values(this.#graph.tasks)) {
      cascade.add(node.conversationId);
      for (const owned of node.conversations) cascade.add(owned);
      if (node.blocked === undefined) continue;
      if (node.conversations.length === 0) blocked.add(node.conversationId);
      else for (const owned of node.conversations) blocked.add(owned);
    }
    // The runs' stored records, live or ended: each one's label, which are forks, and which
    // conversations answered into a successor.
    const labels = new Map<number, string>();
    const forks = new Set<number>();
    const ended = new Set<number>();
    const succeeded = new Set<number>();
    for (const run of runs) {
      labels.set(
        run.id,
        run.input.kind === "fork" ? run.input.prompt : `successor of #${run.conversationId}`,
      );
      if (run.input.kind === "fork") forks.add(run.id);
      else succeeded.add(run.conversationId);
      if (run.state.status === "completing" || run.state.status === "terminal") ended.add(run.id);
    }
    const cwds = new Map<number, string>();
    const prompts = new Map<number, string>();
    const states = new Map<number, LiveState>();
    for (const { id, owner } of conversations) {
      const cwd = (await this.#harness.snapshot(AgentDoc, id as ConversationId, context))?.cwd;
      if (cwd !== undefined) cwds.set(id, cwd);
      const live = await this.#harness.snapshot(LiveDoc, id as ConversationId, context);
      if (live !== undefined) states.set(id, live);
      const prompt = owner === undefined ? await this.#kickoffPrompt(id) : labels.get(owner.taskId);
      if (prompt !== undefined) prompts.set(id, prompt);
    }
    /** A conversation whose story continues elsewhere: a forking run's successor, or a fork
     * child that has ended. Its own stopping is not the human's turn. */
    const closed = (id: number, owner: number | undefined): boolean =>
      succeeded.has(id) || (owner !== undefined && forks.has(owner) && ended.has(owner));
    /** Whether the cascade stopped here with the next move the human's: an open frontier, or a
     * task that cannot move on its own. A closed branch's failure crosses upstream as its result. */
    const stopped = (
      id: number,
      live: LiveState | undefined,
      owner: number | undefined,
    ): boolean => {
      if (blocked.has(id)) return true;
      if (closed(id, owner)) return false;
      if (live?.runFailure !== undefined) return live.runFailure.reason !== "aborted";
      return !cascade.has(id);
    };
    const seen = new Set((await this.#stored(SeenDoc)).seen);
    /** A mark whose stop ended: the cascade moved on, so the next stop flags anew. */
    const retired = new Set<number>();
    /** A stop that landed while someone had its transcript open: not a call for attention. */
    const attended = new Set<number>();
    const summaries = forest(conversations).map(({ id, depth }) => {
      const live = states.get(id);
      const stoppedHere = stopped(id, live, owners.get(id));
      if (!stoppedHere && seen.has(id)) retired.add(id);
      if (stoppedHere && this.#watchers.has(id) && !seen.has(id)) {
        seen.add(id);
        attended.add(id);
      }
      return {
        id,
        label: prompts.get(id)?.split("\n", 1)[0]?.trim() ?? "",
        cwd: cwds.get(id) ?? "",
        depth,
        streaming: live?.run !== undefined,
        attention: stoppedHere && !seen.has(id),
      };
    });
    // Retire the marks whose stops ended, and keep the ones a looker just witnessed: the doc
    // holds only the stops that stand.
    if (retired.size > 0 || attended.size > 0) {
      await this.#harness.commit(async (tx) => {
        const doc = await tx.doc(SeenDoc);
        doc.seen = doc.seen.filter((id) => !retired.has(id));
        for (const id of attended) if (!doc.seen.includes(id)) doc.seen.push(id);
      }, context);
    }
    return summaries;
  }

  /** The conversations and their key.run tasks, as one commit sees them: the graph holds live
   * tasks only, so the list reads the stored records, live or ended. */
  async #scan(): Promise<{
    readonly conversations: readonly ContextConversation[];
    readonly runs: readonly RunRecord[];
  }> {
    return this.#harness.commit(async (tx) => {
      const all = async <T>(
        scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>,
      ): Promise<readonly T[]> => {
        const items: T[] = [];
        let cursor: Cursor | undefined;
        for (;;) {
          const page = await scan(cursor);
          items.push(...page.items);
          if (page.next === undefined) return items;
          cursor = page.next;
        }
      };
      return {
        conversations: (
          await all((cursor) => tx.scanConversations({}, SCAN_PAGE_SIZE, cursor))
        ).map(({ id, owner }) => ({ id, owner })),
        runs: (await all((cursor) =>
          tx.scanTasks({ kind: KeyTask.definition.name }, SCAN_PAGE_SIZE, cursor),
        )) as RunRecord[],
      };
    }, context);
  }

  /** An ownerless conversation is named by the human prompt that started it. */
  async #kickoffPrompt(id: number): Promise<string | undefined> {
    const conversation = await this.#harness.conversation(id as ConversationId, context);
    if (conversation === undefined) throw new Error(`no conversation #${id}`);
    const first = (await conversation.entries({ order: "ascending" }, 1, undefined, context))
      .items[0];
    const message = first?.model?.[0];
    return message?.role === "user" && typeof message.content === "string"
      ? message.content
      : undefined;
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

  async close(): Promise<void> {
    this.#login?.abort();
    const closed = this.#server?.close() ?? Promise.resolve();
    await this.#harness.close(context);
    await closed;
  }
}

/** A task-owned conversation's creator edge, placing it beneath the conversation that forked it. */
type Creator = { readonly taskId: number; readonly conversationId: number };

/** A conversation the list shows, with the task edge that names and places it. */
type ContextConversation = { readonly id: number; readonly owner?: Creator };

/** A key.run's stored record: its input names the conversation it mints. */
type RunRecord = TaskRecord<KeyTaskInput, unknown, string>;

/** A listed conversation placed for display: `depth` hops under its cascade's kickoff. */
type Placed = ContextConversation & { depth: number };

/** The listed conversations in display order: one contiguous block per cascade — the tree rooted
 * at the ownerless kickoff conversation — the newest cascade's block first, and within a block a
 * conversation ahead of its children, siblings ascending by id, so a run's successor follows
 * its forks on their level. */
function forest(conversations: readonly ContextConversation[]): readonly Placed[] {
  const block = (root: ContextConversation, depth: number): readonly Placed[] => [
    { ...root, depth },
    ...conversations
      .filter(({ owner }) => owner?.conversationId === root.id)
      .sort((left, right) => left.id - right.id)
      .flatMap((child) => block(child, depth + 1)),
  ];
  return conversations
    .filter(({ owner }) => owner === undefined)
    .map((root) => block(root, 0))
    .sort(
      (left, right) =>
        Math.max(...right.map(({ id }) => id)) - Math.max(...left.map(({ id }) => id)),
    )
    .flat();
}

/** A working directory's branch, when it is a repository: the footer shows it beside the path.
 * Git answers — symbols, worktrees, reftables, and the environment are its business, not ours. */
async function branchOf(cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined) return undefined;
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd)
    .then((stdout) => stdout.trim())
    .catch(() => "");
  return branch === "" ? undefined : branch;
}
