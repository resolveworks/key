import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  authFile,
  configDir,
  port,
  sandboxFile,
  sessionDir,
  sessionFile,
  worktreesDir,
} from "../src/config.ts";

afterEach(() => vi.unstubAllEnvs());

describe("key paths", () => {
  test("everything lives under ~/.key by default", () => {
    expect(configDir()).toBe(join(homedir(), ".key"));
    expect(sessionDir()).toBe(join(homedir(), ".key"));
    expect(authFile()).toBe(join(homedir(), ".key", "auth.json"));
    expect(sandboxFile()).toBe(join(homedir(), ".key", "sandbox.json"));
    expect(sessionFile()).toBe(join(homedir(), ".key", "session.sqlite"));
    expect(worktreesDir()).toBe(join(homedir(), ".key", "worktrees"));
    expect(port()).toBe(7317);
  });

  test("KEY_CONFIG_DIR moves credentials and the manifest; sessions follow it", () => {
    const config = join(tmpdir(), "key-config");
    vi.stubEnv("KEY_CONFIG_DIR", config);
    expect(configDir()).toBe(config);
    expect(sessionDir()).toBe(config);
    expect(authFile()).toBe(join(config, "auth.json"));
    expect(sandboxFile()).toBe(join(config, "sandbox.json"));
    expect(sessionFile()).toBe(join(config, "session.sqlite"));
  });

  test("KEY_SESSION_DIR moves the database and checkouts, leaving config in place", () => {
    const config = join(tmpdir(), "key-config");
    const sessions = join(tmpdir(), "key-sessions");
    vi.stubEnv("KEY_CONFIG_DIR", config);
    vi.stubEnv("KEY_SESSION_DIR", sessions);
    expect(configDir()).toBe(config);
    expect(sessionDir()).toBe(sessions);
    expect(authFile()).toBe(join(config, "auth.json"));
    expect(sandboxFile()).toBe(join(config, "sandbox.json"));
    expect(sessionFile()).toBe(join(sessions, "session.sqlite"));
    expect(worktreesDir()).toBe(join(sessions, "worktrees"));
  });

  test("~ in a configured directory is the home directory", () => {
    vi.stubEnv("KEY_CONFIG_DIR", "~/key-test");
    expect(configDir()).toBe(join(homedir(), "key-test"));
  });

  test("KEY_PORT names the port", () => {
    vi.stubEnv("KEY_PORT", "7318");
    expect(port()).toBe(7318);
  });
});
