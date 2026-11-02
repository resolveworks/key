// A dumb terminal chat: all state lives in the host; the client keeps which view is open —
// and every view's own draft — and renders the whole screen from that state on change.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AuthType } from "@earendil-works/pi-ai";
import {
  ConversationTranscript,
  type ConversationView,
  type Cursor,
  type EntryRecord,
  type Page,
  type TranscriptView,
} from "@earendil-works/pi-durable";
import {
  type AutocompleteSuggestions,
  type Component,
  Container,
  Editor,
  isKeyRelease,
  type KeybindingsConfig,
  KeybindingsManager,
  matchesKey,
  ProcessTerminal,
  SelectList,
  Spacer,
  setKeybindings,
  Text,
  TUI_KEYBINDINGS,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { hc } from "hono/client";
import type { api } from "./api.ts";
import type { Target } from "./defaults.ts";
import { dot, Footer, type Stats, shortenHome } from "./footer.ts";
import type { Summary } from "./host.ts";
import type { LoginEvent, ProviderInfo } from "./login.ts";
import { LoginPicker, LoginView } from "./login-ui.ts";
import { ModelPicker } from "./model-picker.ts";
import type { ModelDefaults, ModelInfo } from "./models.ts";
import { provider } from "./prompt.ts";
import { selectTheme, style } from "./theme.ts";
import type { ThinkingDefaults } from "./thinking.ts";
import { ThinkingPicker } from "./thinking-picker.ts";
import { transcript } from "./trajectory.ts";

const RECONNECT_MS = 250;
/** Where a client restart picks up: the transcript that was open, if any. */
const cursorFile = join(process.cwd(), ".key", "client.json");

/** This client's opinions over pi-tui's editing grammar: [] claims a key outright, so the
 * input listener below can own ctrl+c and ctrl+y. */
export const keybinds: KeybindingsConfig = {
  "tui.input.copy": [],
  "tui.editor.yank": [],
  "tui.select.cancel": ["escape"],
};

/** A fresh trajectory runs where `/new` named it — by default where the conversation before it ran. */
type View =
  | { readonly kind: "new"; readonly cwd?: string }
  | { readonly kind: "transcript"; readonly id: number };

/** What the screen shows: one view, or an overlay covering the view it left — escape
 * returns there, draft intact. */
type Mode =
  | { readonly kind: "view"; readonly view: View }
  | { readonly kind: "list"; readonly back: View; selected: number | undefined }
  | { readonly kind: "overlay"; readonly back: View; readonly picker: Overlay };

type Overlay = ModelPicker | ThinkingPicker | LoginPicker | LoginView;

/** A view's key in the drafts, and its place in the ring. */
type Name = "new" | number;

const nameOf = (view: View): Name => (view.kind === "new" ? "new" : view.id);

export async function open(base: string): Promise<void> {
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, keybinds));
  const tui = new TuiMainScreen(new ProcessTerminal());
  const client = hc<ReturnType<typeof api>>(base);

  // All client state; every change flows through `render`, which derives the whole screen from it.
  /** The composer: retargeted by `/new`; a place in the ring only while its draft has text. */
  let composer: View = { kind: "new" };
  let mode: Mode = { kind: "view", view: composer };
  /** Every view's unsent text; a swap exchanges them, so a draft never follows its typist. */
  const drafts = new Map<Name, string>();
  let summaries: readonly Summary[] = [];
  let view: TranscriptView | undefined;
  let history: ConversationTranscript | undefined;
  let incoming: Promise<void> = Promise.resolve();
  let stats: Stats | undefined;
  let contextTokens = 0;
  /** A failed action, shown once until the next state replaces it. */
  let notice: string | undefined;
  let starting = false;
  let loginWatch: (() => void) | undefined;

  /** A failed action, shown once until the next state replaces it. */
  const fail = (error: unknown): void => {
    notice = String(error);
    render();
  };

  const streaming = (id: number): boolean =>
    summaries.some((summary) => summary.id === id && summary.streaming);

  /** The view the editor holds the draft of — on screen, or covered by the list. */
  const place = (): View => (mode.kind === "view" ? mode.view : mode.back);

  const openConversation = (): number | undefined =>
    mode.kind === "view" && mode.view.kind === "transcript" ? mode.view.id : undefined;

  /** What `/new` would leave: the open conversation's directory — a child's worktree answered by
   * its cascade's kickoff — or, from the composer, the target it already carries. */
  const leaving = (): { readonly cwd: string } | undefined => {
    const here = place();
    return here.kind === "transcript"
      ? { cwd: inheritCwd(summaries, here.id) }
      : { cwd: here.cwd ?? "" };
  };

  /** The default `/new`'s own completion carries, fixed where the provider is built. */
  const freshDefault = (): string => shortenHome(freshCwd(undefined, leaving(), process.cwd()));

  // The terminal owns the screen and the scrollback: within a view the document only grows, so
  // rendered lines scroll up into history instead of being redrawn. A selector replaces the
  // document and clears the dock and the footer, so the list owns a clean screen.
  const document = new Container();
  const dock = new Container();
  const prompt = new Editor(tui, { borderColor: style.borderMuted, selectList: selectTheme });
  // Completions run on the host's filesystem, not this one; a superseded request is aborted, and
  // the editor wants no answer rather than a crash.
  const complete = async (
    text: string,
    force: boolean,
    signal: AbortSignal,
  ): Promise<AutocompleteSuggestions | null> => {
    try {
      const body = await call(() =>
        client.api.complete.$post(
          { json: { cwd: process.cwd(), text, force } },
          { init: { signal } },
        ),
      );
      return JSON.parse(body) as AutocompleteSuggestions | null;
    } catch (error) {
      if (signal.aborted) return null;
      throw error;
    }
  };
  prompt.setAutocompleteProvider(provider(complete, freshDefault()));
  /** The composer's draft, wherever it lives: the editor's text while open, its store while covered. */
  const composerDraft = (): string =>
    place().kind === "new" ? prompt.getText() : (drafts.get("new") ?? "");
  const footer = new Footer();
  tui.addChild(document);
  tui.addChild(dock);
  tui.addChild(footer);

  let watching: { readonly stop: () => void } | undefined;
  let watchedId: number | undefined;

  const show = (components: readonly Component[]): void => {
    document.clear();
    for (const component of components) document.addChild(component);
  };

  const showPrompt = (): void => {
    dock.clear();
    dock.addChild(prompt);
    tui.setFocus(prompt);
  };

  const hidePrompt = (): void => dock.clear();

  const syncWatch = (): void => {
    const id = openConversation();
    if (id === watchedId) return;
    watching?.stop();
    watching = undefined;
    watchedId = id;
    view = undefined;
    history = undefined;
    incoming = Promise.resolve();
    stats = undefined;
    contextTokens = 0;
    if (id === undefined) return;
    const current = new ConversationTranscript(async (query, limit) => {
      const body = await call(() =>
        client.api.conversations[":id"].entries.$get({
          param: { id: String(id) },
          query: {
            limit: String(limit),
            ...(query.minEntryId === undefined ? {} : { minEntryId: query.minEntryId }),
            ...(query.maxEntryId === undefined ? {} : { maxEntryId: query.maxEntryId }),
            ...(query.order === undefined ? {} : { order: query.order }),
          },
        }),
      );
      return JSON.parse(body) as Page<EntryRecord, Cursor>;
    });
    history = current;
    const url = client.api.conversations[":id"].$url({ param: { id: String(id) } });
    watching = {
      stop: follow<Frame>(url, (frame) => {
        incoming = incoming
          .then(async () => {
            if (history !== current) return;
            view = current.merge(frame.view);
            stats = frame.stats ?? stats;
            contextTokens = frame.contextTokens;
            notice = undefined;
            render();
            const loaded = await loadMissing(current, view);
            if (history !== current) return;
            view = loaded;
            render();
          })
          .catch(fail);
      }),
    };
  };

  /** View = f(state). */
  const render = (): void => {
    syncWatch();
    if (mode.kind === "list") {
      const page = mode;
      hidePrompt();
      const list = makeList(summaries, tui.terminal.rows);
      const index = summaries.findIndex((summary) => summary.id === page.selected);
      if (index >= 0) list.setSelectedIndex(index);
      list.onSelectionChange = (item) => {
        if (mode.kind === "list") mode.selected = Number(item.value);
      };
      list.onSelect = (item) => swap({ kind: "transcript", id: Number(item.value) });
      list.onCancel = () => swap(page.back);
      show([new Spacer(1), list]);
      tui.setFocus(list);
      footer.clear();
    } else if (mode.kind === "overlay") {
      hidePrompt();
      show([mode.picker]);
      tui.setFocus(mode.picker);
      footer.clear();
    } else if (mode.view.kind === "new") {
      showPrompt();
      show([new Text(style.dim("new trajectory · type to start"), 0, 0)]);
      footer.show(mode.view.cwd ?? process.cwd());
    } else {
      const id = mode.view.id;
      showPrompt();
      if (view === undefined) {
        show([new Text(style.dim("connecting…"), 0, 0)]);
        const summary = summaries.find((candidate) => candidate.id === id);
        footer.show(summary?.cwd ?? process.cwd());
      } else {
        show(transcript(view));
        if (stats !== undefined) footer.watch(view, stats, contextTokens);
      }
    }
    if (notice !== undefined) document.addChild(new Text(style.error(notice), 0, 0));
    tui.requestRender();
  };

  /** The one way the open view ever changes: the leaving view keeps its draft, the entering one
   * lends its own, and the cursor records where a restart picks up. */
  const swap = (next: View): void => {
    loginWatch?.();
    loginWatch = undefined;
    drafts.set(nameOf(place()), prompt.getText());
    prompt.setText(drafts.get(nameOf(next)) ?? "");
    saveCursor(next.kind === "transcript" ? next.id : undefined);
    mode = { kind: "view", view: next };
    notice = undefined;
    render();
  };

  /** Cover the screen with the list, opening on the conversation beneath it. */
  const showList = (): void => {
    const here = place();
    mode = { kind: "list", back: here, selected: here.kind === "transcript" ? here.id : undefined };
    notice = undefined;
    render();
  };

  /** Cover the screen with a picker: fetch what it needs and open it, or turn the failure into
   * the notice. */
  const overlay = async (back: View, open: () => Promise<Overlay>): Promise<void> => {
    try {
      const picker = await open();
      mode = { kind: "overlay", back, picker };
      notice = undefined;
      render();
    } catch (error) {
      fail(error);
    }
  };

  /** The picker's enter sets the default its header names and stays open, so one `/model` can
   * set both; escape returns to `back`. */
  const showModels = async (target: Target, back: View): Promise<void> => {
    await overlay(back, async () => {
      const body = await call(() => client.api.models.$get());
      const { models, defaults } = JSON.parse(body) as {
        readonly models: readonly ModelInfo[];
        readonly defaults: ModelDefaults;
      };
      const picker = new ModelPicker(
        tui,
        models,
        defaults,
        target,
        async (chosen, model) => {
          try {
            await call(() =>
              client.api.models.defaults.$post({
                json: { target: chosen, provider: model.provider, modelId: model.id },
              }),
            );
            picker.setDefault(chosen, model);
          } catch (error) {
            fail(error);
          }
        },
        () => swap(back),
      );
      return picker;
    });
  };

  /** The picker's enter sets the default its header names and stays open, so one `/thinking`
   * can set both; escape returns to `back`. */
  const showThinking = async (target: Target, back: View): Promise<void> => {
    await overlay(back, async () => {
      const body = await call(() => client.api.thinking.$get());
      const { defaults } = JSON.parse(body) as { readonly defaults: ThinkingDefaults };
      const picker = new ThinkingPicker(
        tui,
        defaults,
        target,
        async (chosen, level) => {
          try {
            await call(() => client.api.thinking.$post({ json: { target: chosen, level } }));
            picker.setDefault(chosen, level);
          } catch (error) {
            fail(error);
          }
        },
        () => swap(back),
      );
      return picker;
    });
  };

  const showLogin = async (back: View): Promise<void> =>
    overlay(back, async () => {
      const body = await call(() => client.api.providers.$get());
      const providers = JSON.parse(body) as readonly ProviderInfo[];
      return new LoginPicker(
        tui,
        providers,
        (provider, type) => void startLogin(back, provider, type),
        () => swap(back),
      );
    });

  const startLogin = async (back: View, provider: ProviderInfo, type: AuthType): Promise<void> => {
    try {
      await call(() => client.api.login.$post({ json: { provider: provider.id, type } }));
      const view = new LoginView(
        tui,
        provider,
        type,
        (id, value) => void answerLogin(id, value),
        () => void cancelLogin(back),
        (message) => finishLogin(back, provider, type, message),
      );
      mode = { kind: "overlay", back, picker: view };
      notice = undefined;
      render();
      loginWatch = follow<LoginEvent>(client.api.login.$url(), (event) => view.apply(event));
    } catch (error) {
      fail(error);
    }
  };

  const answerLogin = async (id: number, value: string): Promise<void> => {
    try {
      await call(() => client.api.login.respond.$post({ json: { id, value } }));
    } catch (error) {
      fail(error);
    }
  };

  const cancelLogin = async (back: View): Promise<void> => {
    try {
      await call(() => client.api.login.abort.$post());
      swap(back);
    } catch (error) {
      swap(back);
      fail(error);
    }
  };

  const finishLogin = (
    back: View,
    provider: ProviderInfo,
    type: AuthType,
    message: string | undefined,
  ): void => {
    swap(back);
    notice =
      message ??
      (type === "oauth" ? `logged in to ${provider.name}` : `saved API key for ${provider.name}`);
    render();
  };

  /** Clear one view's draft from its store and the editor both. */
  const spend = (): void => {
    drafts.set(nameOf(place()), "");
    prompt.setText("");
  };

  const quit = (): void => {
    watching?.stop();
    tui.stop({ preserveScreen: false });
    process.exit(0);
  };

  /** Send one view's draft: a message to its conversation, or — from the composer — a fresh
   * trajectory. The draft leaves only when the host takes it; a failure leaves it typed, ready
   * to retry. */
  const send = async (from: View, text: string): Promise<void> => {
    const value = text.trim();
    if (value === "" || starting) return;
    starting = true;
    try {
      let opened: number | undefined;
      if (from.kind === "transcript") {
        await call(() =>
          client.api.conversations[":id"].messages.$post({
            param: { id: String(from.id) },
            json: { prompt: value },
          }),
        );
      } else {
        // The trajectory runs where `/new` pointed it; only unnamed and uninherited does it
        // start where the client stands.
        const cwd = from.cwd ?? process.cwd();
        const body = await call(() => client.api.run.$post({ json: { prompt: value, cwd } }));
        opened = (JSON.parse(body) as { conversation: number }).conversation;
      }
      // Spent in the editor too, but only when it still shows the view that sent.
      if (nameOf(place()) === nameOf(from)) spend();
      else drafts.set(nameOf(from), "");
      if (opened !== undefined) swap({ kind: "transcript", id: opened });
      else {
        notice = undefined;
        render();
      }
    } catch (error) {
      fail(error);
    } finally {
      starting = false;
    }
  };

  const interrupt = async (id: number): Promise<void> => {
    try {
      await call(() => client.api.conversations[":id"].abort.$post({ param: { id: String(id) } }));
    } catch (error) {
      fail(error);
    }
  };

  prompt.onSubmit = (text: string): void => {
    if (text.trim() === "/list") {
      spend();
      showList();
      return;
    }
    if (text.trim() === "/model") {
      spend();
      void showModels("conversation", place());
      return;
    }
    if (text.trim() === "/thinking") {
      spend();
      void showThinking("conversation", place());
      return;
    }
    if (text.trim() === "/login") {
      spend();
      void showLogin(place());
      return;
    }
    const fresh = /^\/new(?:\s+(.+))?$/.exec(text.trim());
    if (fresh !== null) {
      // The directory answers here, at the prompt — not as a trajectory failing its first step.
      try {
        composer = { kind: "new", cwd: targetCwd(freshCwd(fresh[1], leaving(), process.cwd())) };
        spend();
        swap(composer);
      } catch (error) {
        fail(error);
      }
      return;
    }
    void send(place(), text);
  };

  // Exit convention: ctrl+c clears the prompt and quits on a second press; ctrl+d quits on an
  // empty prompt, falling through to delete-forward when there is text.
  let lastCtrlC = 0;
  tui.addInputListener((data) => {
    // A kitty terminal reports both events of one press, and pi-tui filters releases only for
    // the focused component — without this, one ctrl+y would cycle twice and one ctrl+c would
    // quit on its own release.
    if (isKeyRelease(data)) return undefined;
    // The picker owns every key while it is open.
    if (mode.kind === "overlay") return undefined;
    if (matchesKey(data, "ctrl+c")) {
      const now = Date.now();
      if (now - lastCtrlC < 500) quit();
      else {
        lastCtrlC = now;
        spend();
        tui.requestRender();
      }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && prompt.getText() === "") {
      quit();
      return { consume: true };
    }
    // Esc interrupts the open conversation's run, as pi's esc esc does. Only on an empty prompt:
    // with a draft, autocomplete may hold the Esc, and the fall-through keeps it the editor's.
    if (matchesKey(data, "escape") && prompt.getText() === "") {
      const id = openConversation();
      if (id !== undefined && streaming(id)) void interrupt(id);
    }
    // Ctrl+y and ctrl+o step through the ring — the drafted composer and the attention
    // conversations — wrapping, alt+tab-style. From a place not in the ring, or with nothing
    // needing attention, the key lands nowhere — still consumed. Ctrl+letters ride their own
    // byte in every terminal, where ctrl+tab is byte-identical to plain tab.
    const chords = [
      ["ctrl+y", 1],
      ["ctrl+o", -1],
    ] as const;
    const direction = chords.find(([key]) => matchesKey(data, key))?.[1];
    if (direction !== undefined) {
      const next = cycle(summaries, nameOf(place()), direction, composerDraft());
      if (next !== undefined) swap(next === "new" ? composer : { kind: "transcript", id: next });
      return { consume: true };
    }
    // Ctrl+l covers the screen with the list, minus `/list`'s spend: nothing was typed, so the
    // covered view keeps its draft. Pressed again, it puts that view back.
    if (matchesKey(data, "ctrl+l")) {
      if (mode.kind === "list") swap(mode.back);
      else showList();
      return { consume: true };
    }
    // In the list the home row steps it: n and e one line, y and o one cascade block — the plain
    // keys under their ctrl cousins, which walk the ring instead of the rows.
    if (mode.kind === "list") {
      const steps = [
        ["n", "line", 1],
        ["e", "line", -1],
        ["y", "cascade", -1],
        ["o", "cascade", 1],
      ] as const;
      const step = steps.find(([key]) => matchesKey(data, key));
      if (step !== undefined) {
        const id = stepList(summaries, mode.selected, step[1], step[2]);
        if (id !== undefined) {
          mode.selected = id;
          render();
        }
        return { consume: true };
      }
    }
    return undefined;
  });

  // The first frame needs no host, so the screen starts on it.
  render();
  tui.start();
  // A resize re-renders what stands, but the list sizes itself from the terminal and must be
  // rebuilt to fill the new one.
  process.stdout.on("resize", () => render());

  // The first summaries are the verdict on the cursor: a stale cursor must land on a fresh
  // trajectory, never a dead view. Every frame after only refreshes the screen.
  const cursor = loadCursor();
  let restored = false;
  follow<readonly Summary[]>(client.api.conversations.$url(), (next) => {
    summaries = next;
    if (!restored) {
      restored = true;
      if (cursor !== undefined && summaries.some((summary) => summary.id === cursor))
        swap({ kind: "transcript", id: cursor });
    }
    render();
  });
}

function loadCursor(): number | undefined {
  try {
    const { conversation } = JSON.parse(readFileSync(cursorFile, "utf8")) as {
      conversation: number | null;
    };
    return conversation ?? undefined;
  } catch {
    return undefined;
  }
}

function saveCursor(conversation: number | undefined): void {
  mkdirSync(join(process.cwd(), ".key"), { recursive: true });
  writeFileSync(cursorFile, JSON.stringify({ conversation: conversation ?? null }));
}

/** The directory `/new` names: `~` is home; whatever does not name a directory throws, and the
 * notice says it where it was typed. */
export function targetCwd(path: string): string {
  const home = homedir();
  const expanded = path === "~" || path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
  const resolved = resolve(expanded);
  if (!statSync(resolved).isDirectory()) throw new Error(`not a directory: ${resolved}`);
  return resolved;
}

/** Where `/new` runs next: its named path, else the directory of the place it leaves, else
 * the client's own. */
export function freshCwd(
  named: string | undefined,
  leaving: { readonly cwd: string } | undefined,
  client: string,
): string {
  return named ?? (leaving?.cwd || client);
}

/** What a conversation hands a fresh trajectory: its own directory at its cascade's head —
 * below the head the head's own, for a distinct directory below a head is a worker's worktree,
 * and a `/new` from a child continues the project, not its checkout. */
export function inheritCwd(summaries: readonly Summary[], id: number): string {
  const at = summaries.findIndex((summary) => summary.id === id);
  const open = summaries[at];
  if (open === undefined || open.depth === 0) return open?.cwd ?? "";
  // One contiguous block per cascade, its kickoff the depth-0 line at its head.
  const kickoff = summaries.slice(0, at + 1).findLastIndex((summary) => summary.depth === 0);
  return summaries[kickoff]?.cwd ?? open.cwd;
}

export function line(summary: Summary): string {
  return `${"  ".repeat(summary.depth)}${dot(summary.streaming)} ${
    summary.attention ? style.warning("!") : " "
  } ${summary.cwd === "" ? "" : `${style.dim(basename(summary.cwd))} · `}${summary.label}`;
}

/** One selectable transcript per row the terminal has, less the spacer above and the scroll
 * indicator below. */
function makeList(summaries: readonly Summary[], rows: number): SelectList {
  return new SelectList(
    summaries.map((summary) => ({ value: String(summary.id), label: line(summary) })),
    Math.max(1, rows - 2),
    selectTheme,
    { minPrimaryColumnWidth: 64, maxPrimaryColumnWidth: 64 },
  );
}

/** The places that need a human as a ring: a drafted composer first, then the attention
 * conversations in the list's order. An empty composer is no place; from a place not in the
 * ring, the first attention forward and the last back; with none, nowhere. */
export function cycle(
  summaries: readonly Summary[],
  current: Name,
  direction: 1 | -1,
  draft: string,
): Name | undefined {
  const drafted = draft.trim() !== "";
  const attention = summaries.filter((summary) => summary.attention).map((summary) => summary.id);
  const ring: readonly Name[] = drafted ? ["new", ...attention] : attention;
  const at = ring.indexOf(current);
  if (at === -1) return attention.at(direction === 1 ? 0 : -1) ?? (drafted ? "new" : undefined);
  return ring[(at + direction + ring.length) % ring.length];
}

/** One step of the list's home row: a line is one entry, a cascade is one block — the run that
 * starts at a kickoff — landing on the neighboring block's kickoff. */
export function stepList(
  summaries: readonly Summary[],
  current: number | undefined,
  move: "line" | "cascade",
  direction: 1 | -1,
): number | undefined {
  if (summaries.length === 0) return undefined;
  const from = Math.max(
    summaries.findIndex(({ id }) => id === current),
    0,
  );
  if (move === "line")
    return summaries[(from + direction + summaries.length) % summaries.length].id;
  const kickoffs = [...summaries.keys()].filter((index) => summaries[index].depth === 0);
  const block = kickoffs.findLastIndex((start) => start <= from);
  return summaries[kickoffs[(block + direction + kickoffs.length) % kickoffs.length]].id;
}

/** Fill the transcript's earlier and gap markers without throwing away its window-aware shape. */
async function loadMissing(
  history: ConversationTranscript,
  initial: TranscriptView,
): Promise<TranscriptView> {
  let view = initial;
  while (view.items[0]?.kind === "earlier") view = await history.loadEarlier(BACKGROUND_CONTEXT);
  for (;;) {
    const gap = view.items.find((item) => item.kind === "gap");
    if (gap === undefined) return view;
    view = await history.fillGap(gap, BACKGROUND_CONTEXT);
  }
}

type Frame = {
  readonly view: ConversationView;
  readonly stats?: Stats;
  readonly contextTokens: number;
};

/** Follow an SSE endpoint as typed frames, reconnecting whenever the host restarts; `pnpm
 * client` runs EventSource behind --experimental-eventsource. */
function follow<T>(url: URL, onFrame: (frame: T) => void): () => void {
  let stopped = false;
  let current: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const attach = (): void => {
    if (stopped) return;
    const source = new EventSource(url);
    current = source;
    source.onmessage = (message) => onFrame(JSON.parse(message.data) as T);
    source.onerror = () => {
      source.close();
      retry = setTimeout(attach, RECONNECT_MS);
    };
  };
  attach();
  return () => {
    stopped = true;
    clearTimeout(retry);
    current?.close();
  };
}

/** Run one client call, retrying only a restarting one. */
async function call(
  request: () => Promise<{ ok: boolean; status: number; text(): Promise<string> }>,
): Promise<string> {
  for (;;) {
    try {
      const response = await request();
      if (!response.ok)
        throw new Error(`host returned ${response.status}: ${await response.text()}`);
      return await response.text();
    } catch (error) {
      // A restarting host refuses the connection; anything else is a real failure.
      if (!(error instanceof TypeError)) throw error;
      await delay(RECONNECT_MS);
    }
  }
}
