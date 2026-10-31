// One provider login, run by the host and watched by the client: pi-ai owns the flow, the host
// relays what it asks and says, and the client sends back the answer. Credentials are persisted
// by the Models' store before `done` is emitted.

import { randomUUID } from "node:crypto";
import type {
  AuthCheck,
  AuthEvent,
  AuthPrompt,
  AuthType,
  Models,
  Provider,
} from "@earendil-works/pi-ai";

/** What `/login` offers for a provider: how it authenticates, and whether it already does. */
export type ProviderInfo = {
  readonly id: string;
  readonly name: string;
  readonly apiKey?: { readonly name: string; readonly login: boolean };
  readonly oauth?: {
    readonly name: string;
    readonly label?: string;
    readonly login: boolean;
    readonly subscription: boolean;
  };
  readonly status?: AuthCheck;
};

/** The login prompt without its AbortSignal, which belongs to the host's flow, not the wire. */
export type LoginPrompt =
  | { readonly type: "text"; readonly message: string; readonly placeholder?: string }
  | { readonly type: "secret"; readonly message: string; readonly placeholder?: string }
  | {
      readonly type: "select";
      readonly message: string;
      readonly options: readonly {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
      }[];
    }
  | { readonly type: "manual_code"; readonly message: string; readonly placeholder?: string };

type LoginEventBody =
  | { readonly kind: "prompt"; readonly id: number; readonly prompt: LoginPrompt }
  | { readonly kind: "notice"; readonly event: AuthEvent }
  | { readonly kind: "done"; readonly provider: string; readonly type: AuthType }
  | { readonly kind: "failed"; readonly message: string };

/** Every event carries its place in the session, so a reconnecting client can ignore replays. */
export type LoginEvent = LoginEventBody & { readonly seq: number };

const promptOf = (prompt: AuthPrompt): LoginPrompt => {
  switch (prompt.type) {
    case "select":
      return { type: "select", message: prompt.message, options: prompt.options };
    case "text":
    case "secret":
    case "manual_code":
      return {
        type: prompt.type,
        message: prompt.message,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      };
  }
};

type Pending = {
  readonly id: number;
  resolve(value: string): void;
  reject(error: Error): void;
  detach(): void;
};

/** A login's events, replayed from wherever a client joins, until the flow is done. */
export class LoginSession {
  readonly provider: Provider;
  readonly type: AuthType;

  #models: Models;
  #controller = new AbortController();
  #events: LoginEvent[] = [];
  #listeners = new Set<() => void>();
  #pending: Pending | undefined;
  #promptId = 0;
  #seq = 0;
  #finished = false;

  constructor(models: Models, provider: Provider, type: AuthType) {
    this.#models = models;
    this.provider = provider;
    this.type = type;
  }

  get events(): readonly LoginEvent[] {
    return this.#events;
  }

  get finished(): boolean {
    return this.#finished;
  }

  /** Start the flow; its prompts arrive through `events`, its answers through `answer`. */
  start(): void {
    void this.#run();
  }

  /** Call whenever an event lands; the callback reads `events` from its own cursor. */
  follow(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  answer(id: number, value: string): void {
    const pending = this.#pending;
    if (pending === undefined || pending.id !== id)
      throw new Error(`no login prompt ${id} is waiting`);
    this.#pending = undefined;
    pending.detach();
    pending.resolve(value);
  }

  abort(): void {
    if (this.#finished) return;
    this.#controller.abort(new Error("Login cancelled"));
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending !== undefined) {
      pending.detach();
      pending.reject(new Error("Login cancelled"));
    }
  }

  #emit(event: LoginEventBody): void {
    this.#events.push({ ...event, seq: ++this.#seq });
    for (const listener of this.#listeners) listener();
  }

  #finish(event: LoginEventBody): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#emit(event);
  }

  async #run(): Promise<void> {
    try {
      await this.#models.login(
        this.provider.id,
        this.type,
        {
          signal: this.#controller.signal,
          prompt: (prompt) => this.#prompt(prompt),
          notify: (event) => this.#emit({ kind: "notice", event }),
        },
        // Account flows such as ChatGPT ask for a UUID naming this installation.
        { getDeviceId: () => randomUUID() },
      );
      await this.#models.refresh({
        providers: [this.provider.id],
        signal: this.#controller.signal,
      });
      this.#finish({ kind: "done", provider: this.provider.id, type: this.type });
    } catch (error) {
      this.#finish({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #prompt(prompt: AuthPrompt): Promise<string> {
    if (this.#finished) return Promise.reject(new Error("login is no longer running"));
    const id = ++this.#promptId;
    this.#emit({ kind: "prompt", id, prompt: promptOf(prompt) });
    return new Promise((resolve, reject) => {
      const signal = prompt.signal;
      const onAbort = (): void => {
        if (this.#pending?.id !== id) return;
        this.#pending = undefined;
        reject(new Error("Login cancelled"));
      };
      const detach = (): void => signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new Error("Login cancelled"));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending = {
        id,
        resolve: (value) => {
          detach();
          resolve(value);
        },
        reject: (error) => {
          detach();
          reject(error);
        },
        detach,
      };
    });
  }
}
