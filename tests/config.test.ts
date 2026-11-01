import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_CACHE_DIRS, loadHostConfig } from "../src/config.ts";

const configPath = (): string => join(mkdtempSync(join(tmpdir(), "key-config-")), "config.json");

const defaults = DEFAULT_CACHE_DIRS.map((d) => join(homedir(), d.slice(2)));

describe("loadHostConfig", () => {
  test("missing file uses defaults", () => {
    expect(loadHostConfig(join(configPath(), "..", "nope.json"))).toEqual({ cacheDirs: defaults });
  });

  test("omitted cacheDirs uses defaults", () => {
    const path = configPath();
    writeFileSync(path, JSON.stringify({}));
    expect(loadHostConfig(path)).toEqual({ cacheDirs: defaults });
  });

  test("supplied list replaces defaults, ~ and absolute paths resolve", () => {
    const path = configPath();
    writeFileSync(path, JSON.stringify({ cacheDirs: ["~/cache", "/abs/cache"] }));
    expect(loadHostConfig(path)).toEqual({
      cacheDirs: [join(homedir(), "cache"), "/abs/cache"],
    });
  });

  test("malformed JSON throws with the path", () => {
    const path = configPath();
    writeFileSync(path, "{nope");
    expect(() => loadHostConfig(path)).toThrow(path);
  });

  test("non-object root throws", () => {
    const path = configPath();
    writeFileSync(path, "[]");
    expect(() => loadHostConfig(path)).toThrow("JSON object");
  });

  test("non-string entries throw", () => {
    const path = configPath();
    writeFileSync(path, JSON.stringify({ cacheDirs: [42] }));
    expect(() => loadHostConfig(path)).toThrow("cacheDirs");
  });

  test("config lives under a missing directory still defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "key-config-"));
    expect(loadHostConfig(join(root, "sub", "config.json"))).toEqual({ cacheDirs: defaults });
  });

  test("an empty directory that exists still ENOENTs", () => {
    const root = mkdtempSync(join(tmpdir(), "key-config-"));
    mkdirSync(join(root, ".key"));
    expect(loadHostConfig(join(root, ".key", "config.json"))).toEqual({ cacheDirs: defaults });
  });
});
