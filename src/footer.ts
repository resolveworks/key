// The footer: the directory the transcript runs in, and beneath it what the run has
// spent — tokens, cache hits, cost — against the model's context window, with the model on the right.

import { homedir } from "node:os";
import type { Usage } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type {
  AgentState,
  ContextView,
  LiveState,
  TranscriptView,
  UsageState,
} from "@earendil-works/pi-durable";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { style } from "./theme.ts";
import { DEFAULT_THINKING_LEVEL } from "./thinking.ts";

/** What the host tells the client about a conversation, beyond its view. */
export type Stats = {
  /** The branch the directory is on, when it is a repository. */
  readonly branch?: string;
  /** The context window of the model the conversation runs. */
  readonly contextWindow: number;
};

/** Compact token counts: 812, 6.4k, 21k, 1.3M. */
export function tokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/** `~/Projects/key` rather than the whole home path; anything else stays as it is. */
export function shortenHome(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** One conversation's own spend: its answers and summarizations, and the tools that reported usage. */
export function totals(state: UsageState | undefined): Usage {
  const total: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const usage of [...Object.values(state?.models ?? {}), ...Object.values(state?.tools ?? {})])
    add(total, usage as Usage);
  return total;
}

function add(total: Usage, usage: Usage): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  if (usage.cacheWrite1h !== undefined)
    total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  total.cost.input += usage.cost.input;
  total.cost.output += usage.cost.output;
  total.cost.cacheRead += usage.cost.cacheRead;
  total.cost.cacheWrite += usage.cost.cacheWrite;
  total.cost.total += usage.cost.total;
}

/** The context the next request carries: pi-ai's estimate over Durable's active model context. */
export function contextTokens(view: ContextView): number {
  return estimateContextTokens(view.messages).tokens;
}

/** The newest cache hit rate: the share of the last answered turn's prompt that it read from cache. */
function cacheHitRate(view: TranscriptView): number | undefined {
  const usage = view.items
    .flatMap((item) => (item.kind === "entry" ? (item.entry.model ?? []) : []))
    .findLast((message) => message.role === "assistant")?.usage;
  if (usage === undefined) return undefined;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
}

/**
 * The green dot the list and the footer put before a conversation: filled while its own run
 * streams, hollow once it settles.
 */
export function dot(streaming: boolean): string {
  return streaming ? style.success("●") : style.dim("○");
}

/**
 * The footer over one transcript: where it runs and what it has spent. `show` names a
 * place the next trajectory would run, `watch` the open transcript, `clear` neither — the
 * selector owns the whole screen — and `render` draws whichever.
 */
export class Footer implements Component {
  #view: TranscriptView | undefined;
  #cwd: string | undefined;
  #branch: string | undefined;
  #window = 0;
  #contextTokens = 0;
  #model = "";
  #thinking = "";

  /** Nothing is cached: the stats are derived from the view the client hands in every frame. */
  invalidate(): void {}

  #reset(): void {
    this.#view = undefined;
    this.#branch = undefined;
    this.#window = 0;
    this.#contextTokens = 0;
    this.#model = "";
    this.#thinking = "";
  }

  /** Where the next trajectory would run, and the host's word on it. */
  show(cwd: string): void {
    this.#reset();
    this.#cwd = cwd;
  }

  /** No place names the list: nothing runs there and none can start, so nothing is drawn. */
  clear(): void {
    this.#reset();
    this.#cwd = undefined;
  }

  /** Draw one transcript: where it runs, what it has spent, and whether it streams. */
  watch(view: TranscriptView, stats: Stats, contextTokens: number): void {
    const agent = view.docs["pi.agent"] as AgentState | undefined;
    this.#view = view;
    this.#cwd = agent?.cwd;
    this.#branch = stats.branch;
    this.#window = stats.contextWindow;
    this.#contextTokens = contextTokens;
    this.#model = agent?.model?.modelId ?? "";
    const level = agent?.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
    this.#thinking = level === "off" ? "thinking off" : level;
  }

  render(width: number): string[] {
    if (this.#cwd === undefined) return [];
    const place = `${style.dim(shortenHome(this.#cwd))}${
      this.#branch === undefined ? "" : style.dim(` (${this.#branch})`)
    }`;
    const lines = [truncateToWidth(place, width, style.dim("..."))];
    if (this.#view === undefined) return lines;

    const usage = totals(this.#view.docs["pi.usage"] as UsageState | undefined);
    const rate = cacheHitRate(this.#view);
    const spent: string[] = [];
    if (usage.input) spent.push(`↑${tokens(usage.input)}`);
    if (usage.output) spent.push(`↓${tokens(usage.output)}`);
    if (usage.cacheRead) spent.push(`R${tokens(usage.cacheRead)}`);
    if (usage.cacheWrite) spent.push(`W${tokens(usage.cacheWrite)}`);
    if (rate !== undefined) spent.push(`CH${rate.toFixed(1)}%`);
    if (usage.cost.total) spent.push(`$${usage.cost.total.toFixed(3)}`);
    spent.push(this.#context(this.#contextTokens));

    const live = this.#view.docs["pi.live"] as LiveState | undefined;
    const left = `${dot(live?.run !== undefined)} ${spent.join(" ")}`;
    const leftWidth = visibleWidth(left);
    const name = truncateToWidth(
      `${this.#model}${this.#thinking === "" ? "" : ` • ${this.#thinking}`}`,
      Math.max(0, width - leftWidth - 2),
      "",
    );
    const gap = Math.max(0, width - leftWidth - visibleWidth(name));
    return [...lines, `${style.dim(left)}${style.dim(`${" ".repeat(gap)}${name}`)}`];
  }

  /** `12.4%/1.0M`, red past 90% and amber past 70%. */
  #context(used: number): string {
    if (this.#window <= 0) return "?";
    const percent = (used / this.#window) * 100;
    const text = `${percent.toFixed(1)}%/${tokens(this.#window)}`;
    return percent > 90 ? style.error(text) : percent > 70 ? style.accent(text) : text;
  }
}
