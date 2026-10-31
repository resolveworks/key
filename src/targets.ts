// The two-defaults state the pickers share: which target tab is on, the defaults as last set, and
// the two lines that name them.

import { type Defaults, otherTarget, type Target, targetName } from "./defaults.ts";
import { style } from "./theme.ts";

/** The two defaults a picker shows and edits, and which of them it is on. */
export class Targets<T> {
  #target: Target;
  #defaults: Defaults<T>;
  readonly #show: (value: T | undefined) => string;

  constructor(defaults: Defaults<T>, target: Target, show: (value: T | undefined) => string) {
    this.#defaults = defaults;
    this.#target = target;
    this.#show = show;
  }

  /** The target tab is on. */
  get target(): Target {
    return this.#target;
  }

  /** The default that target points at. */
  get current(): T | undefined {
    return this.#defaults[this.#target];
  }

  /** Point one default, and edit that one from here on. */
  set(target: Target, value: T): void {
    this.#defaults = { ...this.#defaults, [target]: value };
    this.#target = target;
  }

  /** Tab: edit the other target. */
  toggle(): void {
    this.#target = otherTarget(this.#target);
  }

  /** The line naming both defaults. */
  header(): string {
    const line = (name: string, value: T | undefined) =>
      `${style.muted(name)} ${style.accent(this.#show(value))}`;
    return `${style.muted("defaults")}  ${line("conversations", this.#defaults.conversation)}  ${line("children", this.#defaults.child)}`;
  }

  /** The line naming the target tab is on. */
  hint(note?: string): string {
    const extra = note === undefined ? "" : ` · ${note}`;
    return `${style.accent(`→ ${targetName(this.#target)}`)} ${style.muted(`${extra} · tab switches · enter sets · esc closes`)}`;
  }
}
