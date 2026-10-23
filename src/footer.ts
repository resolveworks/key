// The footer: the directory the transcript runs in, and beneath it what the run has
// spent — tokens, cache hits, cost — against the model's context window, with the model on the right.

import { homedir } from "node:os";
import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ConversationView, UsageState } from "@earendil-works/pi-durable";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { style } from "./theme.ts";

/** What the host tells the client about a conversation, beyond its view. */
export type Stats = {
  /** The branch the directory is on, when it is a repository. */
  readonly branch?: string;
  /** The context window of the model the conversation runs. */
  readonly contextWindow: number;
  /** That model's id: what the right of the stats line names. */
  readonly model: string;
  /** The level the next request runs at. */
  readonly thinkingLevel: ModelThinkingLevel;
  /** The levels that model can run at, in order. */
  readonly thinkingLevels: readonly ModelThinkingLevel[];
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

/** The context the next request carries: pi-ai's estimate over the messages the entries project. */
export function contextTokens(view: ConversationView): number {
  return estimateContextTokens(view.entries.flatMap((entry) => entry.model ?? [])).tokens;
}

/** The newest cache hit rate: the share of the last answered turn's prompt that it read from cache. */
function cacheHitRate(view: ConversationView): number | undefined {
  const usage = view.entries
    .flatMap((entry) => entry.model ?? [])
    .findLast((message) => message.role === "assistant")?.usage;
  if (usage === undefined) return undefined;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
}

/**
 * The dot the list puts before a conversation and the footer before its spend: filled while the
 * chain streams, hollow once it settles.
 */
export function dot(running: boolean): string {
  return running ? style.success("●") : style.dim("○");
}

/**
 * The footer over one transcript: where it runs and what it has spent. `show` names a
 * place the next trajectory would run, `watch` the open transcript, and `render` draws either.
 */
export class Footer implements Component {
  #view: ConversationView | undefined;
  #cwd: string;
  #branch: string | undefined;
  #window = 0;
  #model = "";
  #thinking = "";
  /** The task graph's verdict on this conversation, drawn beside the list's dot from the same graph. */
  #running = false;

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  /** Nothing is cached: the stats are derived from the view the client hands in every frame. */
  invalidate(): void {}

  /** Where the next trajectory would run, and the host's word on it. */
  show(cwd: string): void {
    this.#view = undefined;
    this.#cwd = cwd;
    this.#branch = undefined;
    this.#window = 0;
    this.#model = "";
    this.#thinking = "";
    this.#running = false;
  }

  /** Draw one transcript: where it runs, what it has spent, and whether its chain still streams. */
  watch(view: ConversationView, stats: Stats, running: boolean): void {
    this.#view = view;
    this.#cwd = (view.docs["pi.agent"] as { readonly cwd?: string } | undefined)?.cwd ?? "";
    this.#branch = stats.branch;
    this.#window = stats.contextWindow;
    this.#model = stats.model;
    this.#thinking = stats.thinkingLevel === "off" ? "thinking off" : stats.thinkingLevel;
    this.#running = running;
  }

  render(width: number): string[] {
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
    spent.push(this.#context(contextTokens(this.#view)));

    const left = `${dot(this.#running)} ${spent.join(" ")}`;
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
