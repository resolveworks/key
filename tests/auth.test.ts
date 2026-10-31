import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { describe, expect, test } from "vitest";
import { FileCredentialStore } from "../src/auth.ts";

const authPath = (): string => join(mkdtempSync(join(tmpdir(), "key-auth-")), "auth.json");

describe("FileCredentialStore", () => {
  test("a login survives a fresh Models reading the same file", async () => {
    const path = authPath();
    const first = createModels({ credentials: new FileCredentialStore(path) });
    first.setProvider(deepseekProvider());
    await first.login("deepseek", "api_key", {
      prompt: async () => "sk-test",
      notify: () => {},
    });

    const reopened = createModels({ credentials: new FileCredentialStore(path) });
    reopened.setProvider(deepseekProvider());
    expect(await reopened.getAuth("deepseek")).toMatchObject({
      auth: { apiKey: "sk-test" },
      source: "stored credential",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      deepseek: { type: "api_key", key: "sk-test" },
    });
  });

  test("deleting one credential leaves its neighbours", async () => {
    const path = authPath();
    const store = new FileCredentialStore(path);
    await store.modify("one", async () => ({ type: "api_key", key: "one" }));
    await store.modify("two", async () => ({ type: "api_key", key: "two" }));

    await store.delete("one");
    expect(await store.list()).toEqual([{ providerId: "two", type: "api_key" }]);
    expect(await store.read("two")).toEqual({ type: "api_key", key: "two" });
  });
});
