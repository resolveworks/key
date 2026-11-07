import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  authFile,
  configDir,
  dataDir,
  port,
  sandboxFile,
  sessionFile,
  worktreesDir,
} from "../src/config.ts";

afterEach(() => vi.unstubAllEnvs());

describe("key paths", () => {
  test("defaults to the XDG config and data directories", () => {
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    vi.stubEnv("XDG_DATA_HOME", undefined);
    const config = join(homedir(), ".config", "key");
    const data = join(homedir(), ".local", "share", "key");
    expect(configDir()).toBe(config);
    expect(dataDir()).toBe(data);
    expect(authFile()).toBe(join(config, "auth.json"));
    expect(sandboxFile()).toBe(join(config, "sandbox.json"));
    expect(sessionFile()).toBe(join(data, "session.sqlite"));
    expect(worktreesDir()).toBe(join(data, "worktrees"));
    expect(port()).toBe(7317);
  });

  test("XDG_CONFIG_HOME and XDG_DATA_HOME move each tree", () => {
    const config = join(tmpdir(), "key-config");
    const data = join(tmpdir(), "key-data");
    vi.stubEnv("XDG_CONFIG_HOME", config);
    vi.stubEnv("XDG_DATA_HOME", data);
    expect(configDir()).toBe(join(config, "key"));
    expect(dataDir()).toBe(join(data, "key"));
    expect(authFile()).toBe(join(config, "key", "auth.json"));
    expect(sandboxFile()).toBe(join(config, "key", "sandbox.json"));
    expect(sessionFile()).toBe(join(data, "key", "session.sqlite"));
    expect(worktreesDir()).toBe(join(data, "key", "worktrees"));
  });

  test("KEY_PORT names the port", () => {
    vi.stubEnv("KEY_PORT", "7318");
    expect(port()).toBe(7318);
  });
});
