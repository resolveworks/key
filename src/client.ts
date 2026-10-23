// The client: a dumb terminal chat. It types a prompt, asks the host to start a trajectory, then
// streams it. All state lives in the host; the client keeps a mode and renders from it on change.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import {
  type Component,
  Container,
  Editor,
  matchesKey,
  ProcessTerminal,
  SelectList,
  type SelectListTheme,
  Spacer,
  Text,
  TuiMainScreen,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { hc } from "hono/client";
import type { api } from "./api.ts";
import { Footer, type Stats, WorkingLabel } from "./footer.ts";
import type { Summary } from "./host.ts";
import { provider } from "./prompt.ts";
import { style } from "./theme.ts";
import { transcript } from "./trajectory.ts";

const RECONNECT_MS = 250;
/** Where a client restart picks up: the transcript that was open, if any. */
const cursorFile = join(process.cwd(), ".key", "client.json");

/** The prompt, with what it is waiting on written into its top border. */
class Prompt extends Editor {
  readonly working = new WorkingLabel();

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    const overflow = hiddenLineCount > 0 ? ` ↑${hiddenLineCount}` : "";
    const border = this.working.border(this.borderColor, width - visibleWidth(overflow));
    return truncateToWidth(`${border}${this.borderColor(overflow)}`, width);
  }
}

const selectTheme: SelectListTheme = {
  selectedPrefix: (text) => style.accent(text),
  selectedText: (text) => style.bold(text),
  description: (text) => style.muted(text),
  scrollInfo: (text) => style.dim(text),
  noMatch: (text) => style.dim(text),
};

/** What the screen shows: a fresh trajectory, the resume list, or one open conversation. */
type Mode =
  | { readonly kind: "new" }
  | { readonly kind: "list"; readonly back: "new" | number; selected: number | undefined }
  | { readonly kind: "transcript"; readonly id: number };

/** Attach to the host, chat from the prompt, and open past trajectories from the list. */
export async function open(base: string): Promise<void> {
  const tui = new TuiMainScreen(new ProcessTerminal());
  const client = hc<ReturnType<typeof api>>(base);
  // The terminal owns the screen and the scrollback. Within a view the document only grows, so
  // rendered lines scroll up into history instead of being redrawn. A selector replaces the
  // document and clears the dock, so the list owns a clean screen.
  const document = new Container();
  const dock = new Container();
  const prompt = new Prompt(tui, {
    borderColor: style.borderMuted,
    selectList: selectTheme,
  });
  prompt.setAutocompleteProvider(provider(process.cwd()));
  prompt.working.animate(tui);
  // The last two lines: where this transcript runs, and what it has spent so far.
  const footer = new Footer(process.cwd());
  tui.addChild(document);
  tui.addChild(dock);
  tui.addChild(footer);

  // All client state. Every change flows through `render`, which derives the whole screen from it.
  let mode: Mode = { kind: "new" };
  let summaries: readonly Summary[] = [];
  let view: ConversationView | undefined;
  let stats: Stats | undefined;
  /** The prompt of a trajectory we started; we open its conversation as soon as it appears. */
  let pending: string | undefined;
  /** A failed action, shown once and replaced by whatever the state says next. */
  let notice: string | undefined;
  let starting = false;

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

  /** The one effect: keep the transcript stream in step with the mode. */
  const syncWatch = (): void => {
    const id = mode.kind === "transcript" ? mode.id : undefined;
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
    // The prompt's border says what it waits on; nothing outside a transcript has a prompt.
    prompt.working.show("idle");
    if (mode.kind === "list") {
      const page = mode;
      prompt.setText("");
      hidePrompt();
      const list = makeList(summaries);
      const index = summaries.findIndex((summary) => summary.id === page.selected);
      if (index >= 0) list.setSelectedIndex(index);
      list.onSelectionChange = (item) => {
        if (mode.kind === "list") mode.selected = Number(item.value);
      };
      list.onSelect = (item) => open(Number(item.value));
      list.onCancel = () => (page.back === "new" ? enter({ kind: "new" }) : open(page.back));
      show([new Spacer(1), list]);
      tui.setFocus(list);
      footer.show(process.cwd());
    } else if (mode.kind === "new") {
      showPrompt();
      show([
        pending === undefined
          ? new Text(style.dim("new trajectory · type to start"), 0, 0)
          : new Text(style.dim("starting trajectory…"), 0, 0),
      ]);
      footer.show(process.cwd());
    } else {
      const page = mode;
      showPrompt();
      if (view === undefined) {
        show([new Text(style.dim("connecting…"), 0, 0)]);
        const summary = summaries.find((candidate) => candidate.id === page.id);
        footer.show(summary?.cwd ?? process.cwd());
      } else {
        show(transcript(view));
        if (stats !== undefined) footer.watch(view, stats);
        const live = view.docs["pi.live"] as LiveState | undefined;
        prompt.working.show(live?.run === undefined ? "idle" : "working");
      }
    }
    if (notice !== undefined) show([new Text(style.error(notice), 0, 0)]);
    tui.requestRender();
  };

  /** Enter a mode: records the cursor, then renders. The one way the view ever changes. */
  const enter = (next: Mode): void => {
    if (next.kind === "transcript") saveCursor(next.id);
    mode = next;
    notice = undefined;
    render();
  };

  /** Open a conversation; its lines are only ever appended, so history stays in scrollback. */
  const open = (id: number): void => enter({ kind: "transcript", id });

  const quit = (): void => {
    watching?.stop();
    tui.stop({ preserveScreen: false });
    process.exit(0);
  };

  const start = async (text: string): Promise<void> => {
    const value = text.trim();
    if (value === "" || starting || pending !== undefined) return;
    starting = true;
    try {
      if (mode.kind === "transcript") {
        const id = mode.id;
        await call(() =>
          client.api.conversations[":id"].messages.$post({
            param: { id: String(id) },
            json: { prompt: value },
          }),
        );
      } else {
        // The client's directory is the trajectory's: launch it from the project root.
        await call(() => client.api.run.$post({ json: { prompt: value, cwd: process.cwd() } }));
        pending = value;
      }
      prompt.setText("");
      notice = undefined;
      render();
    } catch (error) {
      notice = String(error);
      render();
    } finally {
      starting = false;
    }
  };

  prompt.onSubmit = (text: string): void => {
    if (text.trim() === "/resume") {
      enter({
        kind: "list",
        back: mode.kind === "transcript" ? mode.id : "new",
        selected: undefined,
      });
      return;
    }
    if (text.trim() === "/new") {
      saveCursor(undefined);
      enter({ kind: "new" });
      return;
    }
    void start(text);
  };

  // Exit convention: ctrl+c clears the prompt and quits on a second press; ctrl+d quits on an
  // empty prompt. With text in the prompt ctrl+d falls through to delete-forward.
  let lastCtrlC = 0;
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      const now = Date.now();
      if (now - lastCtrlC < 500) quit();
      else {
        lastCtrlC = now;
        prompt.setText("");
        tui.requestRender();
      }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && prompt.getText() === "") {
      quit();
      return { consume: true };
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
        enter({ kind: "transcript", id: cursor });
    }
    // Open the pending trajectory once the host has created its conversation.
    if (pending !== undefined) {
      const created = summaries.find((summary) => summary.label === pending);
      if (created !== undefined) {
        pending = undefined;
        open(created.id);
      }
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

/** One selectable transcript: what was asked, where it ran, and whether it runs now. */
function makeList(summaries: readonly Summary[]): SelectList {
  return new SelectList(
    summaries.map((summary) => ({
      value: String(summary.id),
      label: `${summary.running ? style.success("●") : summary.closed ? "×" : style.dim("○")} ${summary.cwd === "" ? "" : `${style.dim(basename(summary.cwd))} · `}${summary.label}`,
    })),
    20,
    selectTheme,
    { minPrimaryColumnWidth: 64, maxPrimaryColumnWidth: 64 },
  );
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

/** Run one client call, retrying only a restarting one; a failure throws with the host's word. */
async function call(
  request: () => Promise<{ ok: boolean; status: number; text(): Promise<string> }>,
): Promise<void> {
  for (;;) {
    try {
      const response = await request();
      if (!response.ok)
        throw new Error(`host returned ${response.status}: ${await response.text()}`);
      return;
    } catch (error) {
      // A restarting host refuses the connection; anything else is a real failure.
      if (!(error instanceof TypeError)) throw error;
      await delay(RECONNECT_MS);
    }
  }
}
