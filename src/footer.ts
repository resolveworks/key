// The footer: the directory the transcript runs in, and beneath it the run's spend — tokens,
// cache hits, cost — against the model's context window, with the model on the right.

import { homedir } from "node:os";
import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ConversationView, LiveState, UsageState } from "@earendil-works/pi-durable";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { style } from "./theme.ts";

/** What the host tells the client about a conversation, beyond its view. */
export type Stats = {
  readonly branch?: string;
  readonly contextWindow: number;
  readonly model: string;
  /** The level the next request runs at. */
  readonly thinkingLevel: ModelThinkingLevel;
};

export function tokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

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

export function contextTokens(view: ConversationView): number {
  return estimateContextTokens(view.entries.flatMap((entry) => entry.model ?? [])).tokens;
}

/** The share of the last answered turn's prompt that it read from cache. */
function cacheHitRate(view: ConversationView): number | undefined {
  const usage = view.entries
    .flatMap((entry) => entry.model ?? [])
    .findLast((message) => message.role === "assistant")?.usage;
  if (usage === undefined) return undefined;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
}

export function dot(streaming: boolean): string {
  return streaming ? style.success("●") : style.dim("○");
}

/** `show` names where the next trajectory would run, `watch` the open transcript, `clear`
 * neither — a selector owns the whole screen. */
export class Footer implements Component {
  #view: ConversationView | undefined;
  #cwd: string | undefined;
  #branch: string | undefined;
  #window = 0;
  #model = "";
  #thinking = "";

  /** Nothing is cached: the stats are derived from the view the client hands in every frame. */
  invalidate(): void {}

  #reset(): void {
    this.#view = undefined;
    this.#branch = undefined;
    this.#window = 0;
    this.#model = "";
    this.#thinking = "";
  }

  show(cwd: string): void {
    this.#reset();
    this.#cwd = cwd;
  }

  /** No place names the list: nothing runs there and none can start. */
  clear(): void {
    this.#reset();
    this.#cwd = undefined;
  }

  watch(view: ConversationView, stats: Stats): void {
    this.#view = view;
    this.#cwd = (view.docs["pi.agent"] as { readonly cwd?: string } | undefined)?.cwd ?? "";
    this.#branch = stats.branch;
    this.#window = stats.contextWindow;
    this.#model = stats.model;
    this.#thinking = stats.thinkingLevel === "off" ? "thinking off" : stats.thinkingLevel;
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
    spent.push(this.#context(contextTokens(this.#view)));

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

  /** Red past 90%, amber past 70%. */
  #context(used: number): string {
    if (this.#window <= 0) return "?";
    const percent = (used / this.#window) * 100;
    const text = `${percent.toFixed(1)}%/${tokens(this.#window)}`;
    return percent > 90 ? style.error(text) : percent > 70 ? style.accent(text) : text;
  }
}
