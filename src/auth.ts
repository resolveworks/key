// Credentials live in `~/.key/auth.json`, one pi-ai credential per provider. The file is the
// host's only provider configuration: no env file, no fallback beyond pi-ai's own auth context.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

type Credentials = Record<string, Credential>;

export class FileCredentialStore implements CredentialStore {
  #path: string;
  /** One write path: every mutation waits for the one before it, so the file never interleaves. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  #read(): Credentials {
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error(`invalid credential file: ${this.#path}`);
    return parsed as Credentials;
  }

  #write(credentials: Credentials): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(credentials, null, 2)}\n`, "utf8");
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.#path);
  }

  /** Mutations are serialized; a read-modify-write never loses the credential beside it. */
  #serial<T>(task: () => Promise<T> | T, options?: AuthOperationOptions): Promise<T> {
    const previous = this.#tail;
    const run = (async () => {
      await previous.catch(() => {});
      options?.signal?.throwIfAborted();
      return task();
    })();
    this.#tail = run.catch(() => {});
    return run;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return this.#read()[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Object.entries(this.#read()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(
    providerId: string,
    modify: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#serial(async () => {
      const credentials = this.#read();
      const current = credentials[providerId];
      const next = await modify(current);
      options?.signal?.throwIfAborted();
      if (next !== undefined) {
        credentials[providerId] = next;
        this.#write(credentials);
      }
      return next ?? current;
    }, options);
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.#serial(() => {
      const credentials = this.#read();
      if (credentials[providerId] === undefined) return;
      delete credentials[providerId];
      this.#write(credentials);
    }, options);
  }
}
