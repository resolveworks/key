// The two-defaults state the pickers share: which target tab is on, the defaults as last set, and
// the two lines that name them.

import { type Defaults, otherTarget, type Target, targetName } from "./defaults.ts";
import { style } from "./theme.ts";

export class Targets<T> {
  #target: Target;
  #defaults: Defaults<T>;
  readonly #show: (value: T | undefined) => string;

  constructor(defaults: Defaults<T>, target: Target, show: (value: T | undefined) => string) {
    this.#defaults = defaults;
    this.#target = target;
    this.#show = show;
  }

  get target(): Target {
    return this.#target;
  }

  get current(): T | undefined {
    return this.#defaults[this.#target];
  }

  set(target: Target, value: T): void {
    this.#defaults = { ...this.#defaults, [target]: value };
    this.#target = target;
  }

  toggle(): void {
    this.#target = otherTarget(this.#target);
  }

  header(): string {
    const line = (name: string, value: T | undefined) =>
      `${style.muted(name)} ${style.accent(this.#show(value))}`;
    return `${style.muted("defaults")}  ${line("conversations", this.#defaults.conversation)}  ${line("children", this.#defaults.child)}`;
  }

  hint(note?: string): string {
    const extra = note === undefined ? "" : ` · ${note}`;
    return `${style.accent(`→ ${targetName(this.#target)}`)} ${style.muted(`${extra} · tab switches · enter sets · esc closes`)}`;
  }
}
