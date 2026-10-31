// The client: a dumb terminal chat. It types a prompt, asks the host to start a trajectory, then
// streams it. All state lives in the host; the client keeps which view is open — and every
// view's own draft — and renders the whole screen from that state on change.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AuthType } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
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
  type SelectListTheme,
  Spacer,
  setKeybindings,
  Text,
  TUI_KEYBINDINGS,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { hc } from "hono/client";
import type { api } from "./api.ts";
import { dot, Footer, type Stats, shortenHome } from "./footer.ts";
import type { Summary } from "./host.ts";
import type { LoginEvent, ProviderInfo } from "./login.ts";
import { LoginPicker, LoginView } from "./login-ui.ts";
import { ModelPicker } from "./model-picker.ts";
import { type ModelDefaults, type ModelInfo, type ModelTarget, targetName } from "./models.ts";
import { provider } from "./prompt.ts";
import { style } from "./theme.ts";
import { transcript } from "./trajectory.ts";

const RECONNECT_MS = 250;
/** Where a client restart picks up: the transcript that was open, if any. */
const cursorFile = join(process.cwd(), ".key", "client.json");

/** This client's opinions over pi-tui's editing grammar. Absent inherits the default, an
 * entry rebinds, and [] claims a key outright: the input listener owns ctrl+c and ctrl+y, so
 * nothing below it may answer to those keys. */
export const keybinds: KeybindingsConfig = {
  "tui.input.copy": [],
  "tui.editor.yank": [],
  "tui.select.cancel": ["escape"],
};

const selectTheme: SelectListTheme = {
  selectedPrefix: (text) => style.accent(text),
  selectedText: (text) => style.bold(text),
  description: (text) => style.muted(text),
  scrollInfo: (text) => style.dim(text),
  noMatch: (text) => style.dim(text),
};

/** One place the screen can be: the composer, where a fresh trajectory's prompt is typed, or
 * one open conversation. A fresh trajectory runs where `/new` named — by default where the
 * conversation before it ran. */
type View =
  | { readonly kind: "new"; readonly cwd?: string }
  | { readonly kind: "transcript"; readonly id: number };

/** What the screen shows: one view, or the list covering the view it left — escape
 * returns there, draft intact. */
type Mode =
  | { readonly kind: "view"; readonly view: View }
  | { readonly kind: "list"; readonly back: View; selected: number | undefined }
  | { readonly kind: "models"; readonly back: View; readonly picker: ModelPicker }
  | { readonly kind: "login"; readonly back: View; readonly picker: LoginPicker }
  | { readonly kind: "login-flow"; readonly back: View; readonly view: LoginView };

/** A view's name: "new" for the composer, its number for a conversation — its key in the drafts,
 * and its place in the ring when it is a live one. */
type Name = "new" | number;

const nameOf = (view: View): Name => (view.kind === "new" ? "new" : view.id);

/** Attach to the host, chat from the prompt, and open past trajectories from the list. */
export async function open(base: string): Promise<void> {
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, keybinds));
  const tui = new TuiMainScreen(new ProcessTerminal());
  const client = hc<ReturnType<typeof api>>(base);

  // All client state. Every change flows through `render`, which derives the whole screen from it.
  /** The composer: one per client, retargeted by `/new` — a place in the ring only while its
   * draft has text; empty, it is just the screen's idle state. */
  let composer: View = { kind: "new" };
  let mode: Mode = { kind: "view", view: composer };
  /** Every view's unsent text. The editor mirrors the open view's entry; a swap exchanges them,
   * so a draft never follows its typist into another conversation. */
  const drafts = new Map<Name, string>();
  let summaries: readonly Summary[] = [];
  let view: ConversationView | undefined;
  let stats: Stats | undefined;
  /** A failed action, shown once and replaced by whatever the state says next. */
  let notice: string | undefined;
  let starting = false;
  /** The login stream, live only while the login view is open. */
  let loginWatch: (() => void) | undefined;

  /** The task graph's verdict on one conversation: the list's dot and everything else read it here. */
  const runs = (id: number): boolean =>
    summaries.some((summary) => summary.id === id && summary.running);

  /** The view the screen is on — or, under the list, the one it covers: the one whose draft the
   * editor holds. */
  const place = (): View => (mode.kind === "view" ? mode.view : mode.back);

  /** The conversation on screen, when the screen is on one: the stream follows it, escape
   * interrupts it. */
  const openConversation = (): number | undefined =>
    mode.kind === "view" && mode.view.kind === "transcript" ? mode.view.id : undefined;

  /** What `/new` would leave: the open conversation's directory — a child's worktree answered
   * by its cascade's kickoff — or, from the composer, the target it already carries. The default
   * it takes and the completion it offers both read it, so neither can name a place the other
   * would not run. */
  const leaving = (): { readonly cwd: string } | undefined => {
    const here = place();
    return here.kind === "transcript"
      ? { cwd: inheritCwd(summaries, here.id) }
      : { cwd: here.cwd ?? "" };
  };

  /** Where a bare `/new` would run — what it would leave, else the client's own — carried by
   * the command's own completion, so a tab types it. */
  const freshDefault = (): string => shortenHome(freshCwd(undefined, leaving(), process.cwd()));

  // The terminal owns the screen and the scrollback. Within a view the document only grows, so
  // rendered lines scroll up into history instead of being redrawn. A selector replaces the
  // document and clears the dock and the footer, so the list owns a clean screen.
  const document = new Container();
  const dock = new Container();
  const prompt = new Editor(tui, { borderColor: style.borderMuted, selectList: selectTheme });
  // The prompt's paths complete on the host: the trajectories run on its filesystem, not this one.
  // A superseded completion aborts its request, and the editor wants no answer rather than a crash.
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
  prompt.setAutocompleteProvider(provider(complete, freshDefault));
  /** The composer's draft — the editor's text while the composer is open, its store while it is
   * covered. Text is what makes the composer a place; the ring asks for it. */
  const composerDraft = (): string =>
    place().kind === "new" ? prompt.getText() : (drafts.get("new") ?? "");
  // The last two lines: where this transcript runs, and what it has spent so far.
  const footer = new Footer();
  tui.addChild(document);
  tui.addChild(dock);
  tui.addChild(footer);

  // Effects: the transcript stream runs exactly while a transcript is open, and the dock holds
  // the prompt exactly when typing is possible.
  let watching: { readonly stop: () => void } | undefined;
  let watchedId: number | undefined;

  /** Replace the document; streaming appends, a view switch starts a new one. */
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

  /** The one effect: keep the transcript stream in step with the open view. */
  const syncWatch = (): void => {
    const id = openConversation();
    if (id === watchedId) return;
    watching?.stop();
    watching = undefined;
    watchedId = id;
    view = undefined;
    stats = undefined;
    if (id === undefined) return;
    const url = client.api.conversations[":id"].$url({ param: { id: String(id) } });
    watching = {
      stop: follow<Frame>(url, (frame) => {
        view = frame.view;
        stats = frame.stats;
        notice = undefined;
        render();
      }),
    };
  };

  /** View = f(state): the whole screen derives from the client state, on every change. */
  const render = (): void => {
    syncWatch();
    // The footer says what the transcript it draws is doing.
    if (mode.kind === "list") {
      const page = mode;
      hidePrompt();
      const list = makeList(summaries);
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
    } else if (mode.kind === "models") {
      hidePrompt();
      show([mode.picker]);
      tui.setFocus(mode.picker);
      footer.clear();
    } else if (mode.kind === "login") {
      hidePrompt();
      show([mode.picker]);
      tui.setFocus(mode.picker);
      footer.clear();
    } else if (mode.kind === "login-flow") {
      hidePrompt();
      show([mode.view]);
      tui.setFocus(mode.view);
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
        // The list's dot and the footer's are one answer from one graph, read in one place.
        if (stats !== undefined) footer.watch(view, stats, runs(id));
      }
    }
    if (notice !== undefined) show([new Text(style.error(notice), 0, 0)]);
    tui.requestRender();
  };

  /** Swap in another view: the leaving one keeps what was typed in it, the entering one lends
   * its own draft, and the cursor records where a restart picks up. The one way the open view
   * ever changes — a conversation's lines are only ever appended, so history stays in scrollback. */
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

  /** Cover the screen with the list; the view beneath keeps its draft for the return. */
  const showList = (): void => {
    mode = { kind: "list", back: place(), selected: undefined };
    notice = undefined;
    render();
  };

  /** Fetch the two defaults and the catalog, then hand the screen to the picker. The
   * picker's enter sets the default its header names and stays open, so one `/model` can set both;
   * escape returns to `back`. */
  const showModels = async (target: ModelTarget, back: View): Promise<void> => {
    let picker: ModelPicker | undefined;
    const set = async (chosen: ModelTarget, model: ModelInfo): Promise<void> => {
      try {
        await call(() =>
          client.api.models.defaults.$post({
            json: { target: chosen, provider: model.provider, modelId: model.id },
          }),
        );
        if (picker !== undefined && mode.kind === "models" && mode.picker === picker)
          picker.setDefault(chosen, model);
        notice = `default ${targetName(chosen)}: ${model.provider}/${model.id}`;
        render();
      } catch (error) {
        notice = String(error);
        render();
      }
    };
    try {
      const body = await call(() => client.api.models.$get());
      const { models, defaults } = JSON.parse(body) as {
        readonly models: readonly ModelInfo[];
        readonly defaults: ModelDefaults;
      };
      picker = new ModelPicker(
        tui,
        models,
        defaults,
        target,
        (chosen, model) => {
          void set(chosen, model);
        },
        () => swap(back),
      );
      mode = { kind: "models", back, picker };
      notice = undefined;
      render();
    } catch (error) {
      notice = String(error);
      render();
    }
  };

  /** Fetch the providers and hand the screen to the login picker. */
  const showLogin = async (back: View): Promise<void> => {
    try {
      const body = await call(() => client.api.providers.$get());
      const providers = JSON.parse(body) as readonly ProviderInfo[];
      const picker = new LoginPicker(
        tui,
        providers,
        (provider, type) => void startLogin(back, provider, type),
        () => swap(back),
      );
      mode = { kind: "login", back, picker };
      notice = undefined;
      render();
    } catch (error) {
      notice = String(error);
      render();
    }
  };

  /** Start the chosen flow on the host, then follow its prompts and notices. */
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
      mode = { kind: "login-flow", back, view };
      notice = undefined;
      render();
      loginWatch = follow<LoginEvent>(client.api.login.$url(), (event) => view.apply(event));
    } catch (error) {
      notice = String(error);
      render();
    }
  };

  const answerLogin = async (id: number, value: string): Promise<void> => {
    try {
      await call(() => client.api.login.respond.$post({ json: { id, value } }));
    } catch (error) {
      notice = String(error);
      render();
    }
  };

  const cancelLogin = async (back: View): Promise<void> => {
    let failure: string | undefined;
    try {
      await call(() => client.api.login.abort.$post());
    } catch (error) {
      failure = String(error);
    }
    swap(back);
    if (failure !== undefined) {
      notice = failure;
      render();
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

  /** Spend the open view's draft: whatever took the text — a command that ran, a clear, a send
   * the host took — it leaves the editor and the view's store both. */
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
   * trajectory, opening the conversation its answer names. The draft leaves only when the host
   * takes it; a failure leaves it typed, ready to retry. */
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
      // The text left its view: that draft is spent — the editor too, when it still shows it.
      if (nameOf(place()) === nameOf(from)) spend();
      else drafts.set(nameOf(from), "");
      if (opened !== undefined) swap({ kind: "transcript", id: opened });
      else {
        notice = undefined;
        render();
      }
    } catch (error) {
      notice = String(error);
      render();
    } finally {
      starting = false;
    }
  };

  /** Interrupt an open conversation's current work. */
  const interrupt = async (id: number): Promise<void> => {
    try {
      await call(() => client.api.conversations[":id"].abort.$post({ param: { id: String(id) } }));
    } catch (error) {
      notice = String(error);
      render();
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
    if (text.trim() === "/login") {
      spend();
      void showLogin(place());
      return;
    }
    const fresh = /^\/new(?:\s+(.+))?$/.exec(text.trim());
    if (fresh !== null) {
      // A path names where the fresh trajectory runs; unnamed it keeps the directory of the
      // place it leaves — the composer's own target, from the composer — the default the
      // completion carries. Either way the directory answers here, at the prompt —
      // not as a trajectory failing its first step.
      try {
        composer = { kind: "new", cwd: targetCwd(freshCwd(fresh[1], leaving(), process.cwd())) };
        spend();
        swap(composer);
      } catch (error) {
        notice = String(error);
        render();
      }
      return;
    }
    void send(place(), text);
  };

  // Exit convention: ctrl+c clears the prompt and quits on a second press; ctrl+d quits on an
  // empty prompt. With text in the prompt ctrl+d falls through to delete-forward.
  let lastCtrlC = 0;
  tui.addInputListener((data) => {
    // A kitty terminal reports both events of one press, and pi-tui filters releases only for
    // the focused component — listeners hear them too. Unheard-of here, one ctrl+y would
    // cycle twice and one ctrl+c would quit on its own release.
    if (isKeyRelease(data)) return undefined;
    // The picker owns every key while it is open: its filter, its list, its escape.
    if (mode.kind === "models" || mode.kind === "login" || mode.kind === "login-flow")
      return undefined;
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
    // Esc interrupts the open conversation's run, as pi's esc esc does. Only an empty prompt: with a
    // draft, autocomplete may hold the Esc, and the fall-through keeps it the editor's.
    if (matchesKey(data, "escape") && prompt.getText() === "") {
      const id = openConversation();
      if (id !== undefined && runs(id)) void interrupt(id);
    }
    // Ctrl+y steps forward through the live places, ctrl+o back, alt+tab-style: a drafted
    // composer and the running conversations in the list's order are the ring, and it wraps — so a
    // `/new` in progress, draft and all, is ever a step away. An empty composer is no place, and
    // with nothing live the key lands nowhere — still consumed. Ctrl+letters ride their own byte
    // in every terminal — Konsole included — where ctrl+tab is byte-identical to plain tab.
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
    // Ctrl+l covers the screen with the list — the /list command at a press, minus its spend:
    // nothing was typed, so the covered view keeps its draft for the return.
    if (matchesKey(data, "ctrl+l")) {
      showList();
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

  // The first frame is already a complete view, so it starts on the one view that needs no host.
  render();
  tui.start();

  // The first summaries are the verdict on the cursor: a cursor is a hint, never a fact, and a
  // stale one must land on a fresh trajectory rather than a dead view. Every frame after only
  // refreshes the screen — the list's status dots included.
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

/** The transcript the last client had open, if it is still there. */
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

/** The directory `/new` names: `~` is home, everything else resolves against the client's own
 * cwd. Whatever does not name a directory throws — the notice says it where it was typed. */
export function targetCwd(path: string): string {
  const home = homedir();
  const expanded = path === "~" || path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
  const resolved = resolve(expanded);
  if (!statSync(resolved).isDirectory()) throw new Error(`not a directory: ${resolved}`);
  return resolved;
}

/** Where `/new` starts the next trajectory: the path it named, else the directory of the place
 * it leaves — the conversation open, or the composer's own target — else the client's own. The
 * command's completion carries the answer, so the default is on the line and a path is
 * an invitation to differ from it. */
export function freshCwd(
  named: string | undefined,
  leaving: { readonly cwd: string } | undefined,
  client: string,
): string {
  return named ?? (leaving?.cwd || client);
}

/** What a conversation hands a fresh trajectory: its own directory at its cascade's head — and
 * below the head, the head's own, for the only directory below a head is a forked child's
 * worktree, and a `/new` from a child continues the project, not its checkout. */
export function inheritCwd(summaries: readonly Summary[], id: number): string {
  const at = summaries.findIndex((summary) => summary.id === id);
  const open = summaries[at];
  if (open === undefined || open.depth === 0) return open?.cwd ?? "";
  // The list is the graph flattened: one contiguous block per cascade, its kickoff the depth-0
  // line at its head — the first one at or before this conversation is its own.
  const kickoff = summaries.slice(0, at + 1).findLastIndex((summary) => summary.depth === 0);
  return summaries[kickoff]?.cwd ?? open.cwd;
}

/** One line of the list: the cascade's depth as indentation, two spaces a level, ahead of
 * the running dot, then the directory and the prompt. */
export function line(summary: Summary): string {
  return `${"  ".repeat(summary.depth)}${dot(summary.running)} ${
    summary.cwd === "" ? "" : `${style.dim(basename(summary.cwd))} · `
  }${summary.label}`;
}

/** One selectable transcript: what was asked, where it ran, and whether it runs now. */
function makeList(summaries: readonly Summary[]): SelectList {
  return new SelectList(
    summaries.map((summary) => ({ value: String(summary.id), label: line(summary) })),
    20,
    selectTheme,
    { minPrimaryColumnWidth: 64, maxPrimaryColumnWidth: 64 },
  );
}

/** The live places as a ring: a drafted composer first — a trajectory being written is the newest
 * thing — then the running conversations in the list's order, newest cascade first. The composer is a
 * place only while its draft has text; an empty `/new` never joins the ring. From one of the
 * places, its neighbor in `direction`, wrapping — so a trajectory in progress is ever a step
 * away. From a place not in the ring — a settled conversation, an empty composer — the first
 * running forward and the last back; with none running, the drafted composer; with nothing
 * live, nowhere. */
export function cycle(
  summaries: readonly Summary[],
  current: Name,
  direction: 1 | -1,
  draft: string,
): Name | undefined {
  const drafted = draft.trim() !== "";
  const running = summaries.filter((summary) => summary.running).map((summary) => summary.id);
  const ring: readonly Name[] = drafted ? ["new", ...running] : running;
  const at = ring.indexOf(current);
  if (at === -1) return running.at(direction === 1 ? 0 : -1) ?? (drafted ? "new" : undefined);
  return ring[(at + direction + ring.length) % ring.length];
}

/** One step of the list's home row: a line is one entry, a cascade is one block — the run that
 * starts at a kickoff, depth 0 — landing on the neighboring block's kickoff. Both wrap, as the
 * list's own arrows do, and an empty list leaves nowhere to go. */
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

/** One frame of a transcript: its view, and the stats the view cannot carry. */
type Frame = { readonly view: ConversationView; readonly stats: Stats };

/** Follow an SSE endpoint as typed frames, reconnecting whenever the host restarts. The platform's
 * EventSource owns the connection; `pnpm client` runs it behind --experimental-eventsource. */
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

/** Run one client call, retrying only a restarting one; a failure throws with the host's word. The
 * answer is the host's body, for whoever asked for it. */
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
