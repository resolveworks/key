// The host: one process owns the Session on SQLite and serves the transcripts over HTTP+SSE.
import { mkdirSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AuthType,
  clampThinkingLevel,
  contentText,
  type Models,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  type AgentChange,
  AgentDoc,
  type AgentState,
  type ConversationId,
  type ConversationRecord,
  type ConversationView,
  type Cursor,
  createRegistry,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Extension,
  Harness,
  type JsonObject,
  LiveDoc,
  type ModelRef,
  type Page,
  type SessionDocToken,
  type Storage,
  type TaskGraph,
  type TaskRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { localDaemon } from "@earendil-works/pi-env";
import { type AutocompleteSuggestions, CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { type ServerType, serve } from "@hono/node-server";
import type { Hono } from "hono";
import { Agents } from "./agents.ts";
import { api } from "./api.ts";
import { FileCredentialStore } from "./auth.ts";
import { authFile, dataDir, port, sessionFile } from "./config.ts";
import { targetCwd } from "./cwd.ts";
import type { Target } from "./defaults.ts";
import { Fetch } from "./fetch.ts";
import { contextTokens as activeContextTokens, type Stats } from "./footer.ts";
import { git } from "./git.ts";
import { LoginSession, type ProviderInfo } from "./login.ts";
import { type ModelDefaults, ModelDefaultsDoc, type ModelInfo } from "./models.ts";
import { loadSandboxManifest, type SandboxManifest, sandboxEnv } from "./sandbox.ts";
import { Search } from "./search.ts";
import { SeenDoc } from "./seen.ts";
import {
  CONVERSATION_INSTRUCTIONS,
  CONVERSATION_TASK,
  type ConversationTaskInput,
  keySystem,
} from "./system.ts";
import { DEFAULT_THINKING_LEVEL, type ThinkingDefaults, ThinkingDefaultsDoc } from "./thinking.ts";

/** The host's key, its git bound to the real one. */

const context = BACKGROUND_CONTEXT;
const SCAN_PAGE_SIZE = 256;

/** What the host runs on, resolved before the host is constructed. */
export type HostOptions = {
  readonly models: Models;
  readonly storage: Storage;
  readonly extensions: readonly Extension[];
  readonly port: number;
  /** The interface the server listens on: `KEY_BIND`, loopback by default. */
  readonly hostname: string;
  /** The declared mounts and environment every conversation's sandbox gets. */
  readonly manifest: SandboxManifest;
};

/** One box's defaults: the configured session, pi's models, and the declared sandbox. */
export async function production(): Promise<HostOptions> {
  const manifest = loadSandboxManifest();
  const models = builtinModels({ credentials: new FileCredentialStore(authFile()) });
  mkdirSync(dataDir(), { recursive: true });
  return {
    models,
    manifest,
    storage: await openNodeSqliteStorage(sessionFile()),
    extensions: [CodingTools, keySystem(git), Search, Fetch, Agents],
    port: port(),
    hostname: process.env.KEY_BIND ?? "127.0.0.1",
  };
}

/** One line in the transcript picker: a conversation, whether it streams, and whether it needs a human. */
export type Summary = {
  readonly id: number;
  /** The prompt that started this conversation. */
  readonly label: string;
  /** The directory this conversation runs in, unset until the conversation is configured. */
  readonly cwd?: string;
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

  constructor(options: HostOptions) {
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
      const remaining = this.#watchers.get(id);
      if (remaining === undefined)
        throw new Error(`conversation #${id} was not counted as watched`);
      if (remaining === 1) this.#watchers.delete(id);
      else this.#watchers.set(id, remaining - 1);
    });
    return watch;
  }

  /** Page the raw history behind a view's bounded window. */
  async entries(
    id: number,
    query: Omit<EntryQuery, "conversationId">,
    limit: number,
  ): Promise<Page<EntryRecord, Cursor>> {
    const conversation = await this.#harness.conversation(id as ConversationId, context);
    if (conversation === undefined) throw new Error(`no conversation #${id}`);
    return conversation.entries(query, limit, undefined, context);
  }

  /** The next request's context size, from its active messages rather than the rendered window. */
  async contextTokens(id: number): Promise<number> {
    const conversation = await this.#harness.conversation(id as ConversationId, context);
    if (conversation === undefined) throw new Error(`no conversation #${id}`);
    return activeContextTokens(await conversation.context(context));
  }

  /** The models of configured providers, and the two defaults `/model` edits. */
  async modelSettings(): Promise<{
    readonly defaults: ModelDefaults;
    readonly models: readonly ModelInfo[];
  }> {
    const [models, defaults] = await Promise.all([
      this.#options.models.getAvailable(),
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
    const models = this.#options.models;
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
    const models = this.#options.models;
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
    if (this.#options.models.getModel(ref.provider, ref.modelId) === undefined)
      throw new Error(`unknown model: ${ref.provider}/${ref.modelId}`);
    await this.#harness.commit(async (tx) => {
      (await tx.doc(ModelDefaultsDoc))[target] = { ...ref };
    }, context);
  }

  /** What a view cannot say: the branch and the context window. */
  async stats(view: ConversationView): Promise<Stats> {
    const agent = view.docs["pi.agent"] as AgentState | undefined;
    if (agent?.model === undefined)
      throw new Error(`conversation ${view.conversation.id} has no model`);
    const model = this.#model(agent.model);
    const branch = await branchOf(agent.cwd);
    return {
      ...(branch === undefined ? {} : { branch }),
      contextWindow: model.contextWindow,
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
      this.#options.storage,
      {
        models: this.#options.models,
        registry,
        env: (target, context) => {
          // A conversation without a root is a bug to surface, not to paper over.
          if (target.cwd === undefined)
            throw new Error(`conversation ${target.conversationId} has no cwd`);
          return sandboxEnv(
            target.conversationId,
            target.cwd,
            localDaemon(),
            this.#options.manifest,
            context,
          );
        },
        onReport: (report) => console.error("key:", report),
      },
      context,
    );

    // `start()` delivers pending frames only, so the recovered graph must be taken from the
    // watch itself: the first publish below would otherwise see no live tasks after a restart.
    const watch = await this.#harness.watchTaskGraph(context);
    this.#graph = watch.value;
    watch.start(async (call) => {
      if (call.kind !== "value") return;
      this.#graph = call.value;
      await this.#publish();
    });
    await this.#publish();
  }

  /** One catalog model, or the loud failure of a default that names none. */
  #model(ref: { readonly provider: string; readonly modelId: string }) {
    const model = this.#options.models.getModel(ref.provider, ref.modelId);
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

  /** Resolve a directory the client names against the host's filesystem. */
  resolveCwd(path: string, cwd: string | undefined): string {
    return targetCwd(path, cwd);
  }

  /** Start a cascade in a directory the client has already resolved. */
  async run(cwd: string, prompt: string): Promise<number> {
    cwd = targetCwd(cwd, undefined);
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
          instructions: CONVERSATION_INSTRUCTIONS,
        },
      },
      context,
    );
    await conversation.submit({ type: "input", content: prompt, whenBusy: "steer" }, context);
    return conversation.id;
  }

  /** Fork a conversation at an entry: an independent cascade that inherits the history up to and
   * including that entry, with the agent as it stood there. Without an entry the fork starts empty,
   * carrying the agent as it stands now. The source keeps running as it was. */
  async fork(conversationId: number, at?: EntryId): Promise<number> {
    const id = conversationId as ConversationId;
    const conversation = await this.#harness.conversation(id, context);
    if (conversation === undefined) throw new Error(`no conversation #${conversationId}`);
    const ownership = { kind: "ownerless" } as const;
    const fork =
      at === undefined
        ? await this.#harness.createConversation(
            { ownership, agent: await this.#agentOf(id) },
            context,
          )
        : await conversation.fork(at, { ownership }, context);
    await this.#publish();
    return fork.id;
  }

  /** A conversation's stored agent as a creating conversation takes it: the choices whose
   * create-option shape matches the document's — extensions and tools are stored by name, created
   * by object — so an empty fork keeps its source's model, directory, thinking, and instructions. */
  async #agentOf(id: ConversationId): Promise<AgentChange> {
    const stored = await this.#harness.snapshot(AgentDoc, id, context);
    if (stored === undefined) throw new Error(`no agent for conversation #${id}`);
    const { model, thinkingLevel, instructions, cwd, maxTurns } = stored;
    return { model, thinkingLevel, instructions, cwd, maxTurns };
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

  /** Recompute the transcript list as one commit that also settles the seen marks it says are
   * due, then push it to every attached client. The settle writes documents only, and the
   * task-graph watch advances on task and conversation records alone, so publishing cannot
   * recurse through it. */
  async #publish(): Promise<void> {
    const summaries = await this.#harness.commit(async (tx) => {
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
      const runs = (await all((cursor) =>
        tx.scanTasks({ kind: CONVERSATION_TASK }, SCAN_PAGE_SIZE, cursor),
      )) as RunRecord[];
      // The list is the conversations that own a story: a cascade's kickoff and its
      // key.conversation children. Tool-private continuations (key.ask forks) stay durable
      // but never list.
      const listed = new Set(runs.map(({ id }) => Number(id)));
      const conversations = (
        await all((cursor) => tx.scanConversations({}, SCAN_PAGE_SIZE, cursor))
      )
        .map(({ id, owner }) => ({ id, owner }))
        .filter(({ owner }) => owner === undefined || listed.has(Number(owner.taskId)));
      // Read each opening prompt and per-conversation document in the same commit, so every agent
      // has the same label source and the list is one consistent picture. Drafts live only inside
      // the commit, and the list needs just two scalars of the live one.
      const detail: ListedConversation[] = [];
      for (const { id, owner } of conversations) {
        const first = (
          await tx.scanEntries({ conversationId: id as ConversationId, order: "ascending" }, 1)
        ).items[0];
        const message = first?.model?.[0];
        const live = await tx.doc(LiveDoc, id as ConversationId);
        detail.push({
          id,
          owner,
          label:
            message?.role === "user" ? contentText(message.content).split("\n", 1)[0].trim() : "",
          cwd: (await tx.doc(AgentDoc, id as ConversationId)).cwd,
          streaming: live.run !== undefined,
          aborted: live.runFailure?.reason === "aborted",
        });
      }
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
      // The runs' stored records, live or ended: which are children, and which conversations
      // answered into a successor.
      const children = new Set<number>();
      const ended = new Set<number>();
      const succeeded = new Set<number>();
      for (const run of runs) {
        if (run.input.kind !== "successor") children.add(run.id);
        else succeeded.add(run.conversationId);
        if (run.state.status === "completing" || run.state.status === "terminal") ended.add(run.id);
      }
      /** A conversation whose story continues elsewhere: a successor, or a child that has ended. */
      const closed = ({ id, owner }: ListedConversation): boolean =>
        succeeded.has(id) ||
        (owner !== undefined && children.has(owner.taskId) && ended.has(owner.taskId));
      /** Whether the cascade stopped here with the next move the human's: an open frontier, or a
       * task that cannot move on its own. A closed branch's failure crosses upstream as its
       * result. An aborted run is the human's own hand, so it never flags. */
      const stopped = (conversation: ListedConversation): boolean => {
        if (blocked.has(conversation.id)) return true;
        if (closed(conversation)) return false;
        if (conversation.aborted) return false;
        return !cascade.has(conversation.id);
      };
      // The settled marks are the doc: retire the stops that ended — the cascade moved on, so the
      // next stop flags anew — and stand the ones a looker just witnessed.
      const seenDoc = await tx.doc(SeenDoc);
      const seen = new Set(seenDoc.seen);
      let changed = false;
      const summaries = forest(detail).map((conversation) => {
        const { id, depth, label, cwd, streaming } = conversation;
        const stoppedHere = stopped(conversation);
        if (stoppedHere && this.#watchers.has(id) && !seen.has(id)) {
          seen.add(id);
          changed = true;
        } else if (!stoppedHere && seen.delete(id)) changed = true;
        return {
          id,
          label,
          cwd,
          depth,
          streaming,
          attention: stoppedHere && !seen.has(id),
        };
      });
      if (changed) seenDoc.seen = [...seen];
      return summaries;
    }, context);
    this.#summaries = summaries;
    for (const listener of this.#listeners) listener(this.#summaries);
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

/** A conversation the list shows, with the task edge that names and places it. */
type ContextConversation = Pick<ConversationRecord, "id" | "owner">;

/** The same conversation with what its opening prompt and documents say. */
type ListedConversation = ContextConversation & {
  readonly label: string;
  readonly cwd: string | undefined;
  readonly streaming: boolean;
  readonly aborted: boolean;
};

/** A key.conversation's stored record: its input names the conversation it mints. */
type RunRecord = TaskRecord<ConversationTaskInput, unknown, string>;

/** The listed conversations in display order: one contiguous block per cascade — the tree rooted
 * at the ownerless kickoff conversation — the newest root first, so a cascade keeps its place as
 * its children and successors arrive, and within a block a conversation ahead of its children,
 * siblings ascending by id, so a run's successor follows its children on their level. */
function forest<T extends ContextConversation>(
  conversations: readonly T[],
): readonly (T & { readonly depth: number })[] {
  const block = (root: T, depth: number): readonly (T & { readonly depth: number })[] => [
    { ...root, depth },
    ...conversations
      .filter(({ owner }) => owner?.conversationId === root.id)
      .sort((left, right) => left.id - right.id)
      .flatMap((child) => block(child, depth + 1)),
  ];
  return conversations
    .filter(({ owner }) => owner === undefined)
    .sort((left, right) => right.id - left.id)
    .flatMap((root) => block(root, 0));
}

/** A working directory's branch, when it is a repository: the footer shows it beside the path.
 * Git answers — symbols, worktrees, reftables, and the environment are its business, not ours. */
async function branchOf(cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined) return undefined;
  try {
    const branch = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd)).trim();
    return branch === "" ? undefined : branch;
  } catch (error) {
    // A detached HEAD or a directory outside any repository has no branch to show.
    const exit = (error as { cause?: { code?: unknown } }).cause?.code;
    if (exit === 1 || exit === 128) return undefined;
    throw error;
  }
}
