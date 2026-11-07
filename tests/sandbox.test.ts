// The bwrap argv we build; enforcing it is bwrap's job.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { loadSandboxManifest, sandboxCommand, sandboxEnv } from "../src/sandbox.ts";

const context = BACKGROUND_CONTEXT;
const daemon = "/daemon";
const home = homedir();
const runtimeDirectory = join("/run/user", String(userInfo().uid));
const store = join(home, ".local/share/pnpm");
const temporary: string[] = [];

/** The manifest the host reads, with `~` for the loader to expand. */
const declaration = {
  mount: [
    { path: "~/.local/share/pnpm" },
    { path: "~/.cache/pnpm" },
    { path: "~/.local/state/pnpm" },
    { path: "~/.cache/uv" },
    { path: "~/.local/share/uv" },
    { path: "~/.local/bin" },
    { path: "~/.cargo" },
    { path: "~/.gitconfig", readonly: true },
    { path: "~/.ssh/config", readonly: true },
    { path: "~/.ssh/known_hosts", readonly: true },
    { path: "~/.ssh/id_ed25519.pub", readonly: true },
    { path: "~/.ssh/agent.sock" },
    { path: "~/Projects", readonly: true },
    { path: "~/android", readonly: true },
  ],
  env: {
    LANG: "en_US.UTF-8",
    PATH: "/usr/local/bin:/usr/bin:/bin:~/.local/share/pnpm/bin:~/.local/bin:~/.cargo/bin",
    SSH_AUTH_SOCK: "~/.ssh/agent.sock",
    UV_PREVIEW_FEATURES: "centralized-project-envs",
    PNPM_HOME: "~/.local/share/pnpm",
    pnpm_config_store_dir: "~/.local/share/pnpm/store",
    pnpm_config_enable_global_virtual_store: "true",
  },
};

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function writeManifest(value: unknown): string {
  const file = join(temp("key-sandbox-manifest-"), "sandbox.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

function loaded(): ReturnType<typeof loadSandboxManifest> {
  return loadSandboxManifest(writeManifest(declaration));
}

function indexOf(command: readonly string[], ...tokens: string[]): number {
  outer: for (let index = 0; index <= command.length - tokens.length; index++) {
    for (let offset = 0; offset < tokens.length; offset++) {
      if (command[index + offset] !== tokens[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

describe("sandboxCommand", () => {
  // The pre-commit hook exports GIT_DIR for the repository it commits, and the probe asks git about
  // cwd: a sandbox daemon started by hand carries no such thing.
  beforeAll(() => {
    for (const name of Object.keys(process.env))
      if (name.startsWith("GIT_")) delete process.env[name];
  });

  test("binds the declared mounts in order around a private home", () => {
    const config = loaded();
    const cwd = temp("key-sandbox-order-");
    const command = sandboxCommand(cwd, daemon, config);
    const root = indexOf(command, "--ro-bind", "/", "/");
    const proc = indexOf(command, "--proc", "/proc");
    const dev = indexOf(command, "--dev", "/dev");
    const tmp = indexOf(command, "--tmpfs", "/tmp");
    const runtime = indexOf(command, "--tmpfs", runtimeDirectory);
    const privateHome = indexOf(command, "--tmpfs", home);

    expect(root).toBeGreaterThanOrEqual(0);
    expect(proc).toBeGreaterThan(root);
    expect(dev).toBeGreaterThan(proc);
    expect(tmp).toBeGreaterThan(dev);
    expect(runtime).toBeGreaterThan(tmp);
    expect(privateHome).toBeGreaterThan(runtime);

    let previous = privateHome;
    for (const mount of config.mount) {
      const option = mount.readonly === true ? "--ro-bind" : "--bind";
      const at = indexOf(command, option, mount.path, mount.path);
      expect(at).toBeGreaterThan(previous);
      previous = at;
    }

    const worktree = indexOf(command, "--bind", cwd, cwd);
    expect(worktree).toBeGreaterThan(previous);
    const binary = indexOf(command, "--ro-bind", daemon, daemon);
    expect(binary).toBeGreaterThan(worktree);
    const cleared = indexOf(command, "--clearenv");
    expect(cleared).toBeGreaterThan(binary);
    expect(indexOf(command, "--chdir", cwd)).toBeGreaterThan(cleared);
    expect(command.slice(-2)).toEqual(["--", daemon]);
  });

  test("clears the environment and sets only the declared variables", () => {
    const config = loaded();
    const command = sandboxCommand(temp("key-sandbox-env-"), daemon, config);
    const environment = new Map<string, string>();
    for (let index = 0; index < command.length; index++) {
      if (command[index] === "--setenv") environment.set(command[index + 1], command[index + 2]);
    }

    expect(indexOf(command, "--clearenv")).toBeGreaterThanOrEqual(0);
    expect(environment.get("HOME")).toBe(home);
    expect(environment.get("TMPDIR")).toBe("/tmp");
    expect(environment.get("XDG_RUNTIME_DIR")).toBe(runtimeDirectory);
    for (const [name, value] of Object.entries(config.env)) {
      expect(environment.get(name)).toBe(value);
    }
    expect([...environment.keys()].sort()).toEqual(
      [
        "HOME",
        "TMPDIR",
        "XDG_RUNTIME_DIR",
        "LANG",
        "PATH",
        "SSH_AUTH_SOCK",
        "UV_PREVIEW_FEATURES",
        "PNPM_HOME",
        "pnpm_config_store_dir",
        "pnpm_config_enable_global_virtual_store",
      ].sort(),
    );
    expect([...environment.keys()].filter((name) => name.startsWith("KEY_"))).toEqual([]);
    expect(environment.has("BRAVE_API_KEY")).toBe(false);
  });

  test("no writable mount of home, and every writable mount is bound at its own path", () => {
    const config = loaded();
    const command = sandboxCommand(temp("key-sandbox-writable-"), daemon, config);
    const root = indexOf(command, "--ro-bind", "/", "/");

    expect(indexOf(command, "--bind", home, home)).toBe(-1);
    for (const mount of config.mount) {
      const option = mount.readonly === true ? "--ro-bind" : "--bind";
      expect(indexOf(command, option, mount.path, mount.path)).toBeGreaterThan(root);
    }
  });

  test("mounts the store even when its selectors are not declared", () => {
    const withoutSelectors = loadSandboxManifest(
      writeManifest({ mount: [{ path: "~/.local/share/pnpm" }], env: {} }),
    );
    const command = sandboxCommand(temp("key-sandbox-store-"), daemon, withoutSelectors);

    expect(indexOf(command, "--bind", store, store)).toBeGreaterThanOrEqual(0);

    // The selectors are load-bearing: they must name the store the manifest mounts.
    const config = loaded();
    expect(config.mount.some(({ path }) => path === store)).toBe(true);
    expect(config.env.PNPM_HOME).toBe(store);
    expect(config.env.pnpm_config_store_dir).toBe(join(store, "store"));
  });

  test("a missing file, an unknown key or a wrong type throws with the file and field", () => {
    const missing = join(temp("key-sandbox-missing-"), "sandbox.json");
    expect(() => loadSandboxManifest(missing)).toThrow(missing);

    const unknown = writeManifest({ mount: [{ path: "/x", writable: true }], env: {} });
    expect(() => loadSandboxManifest(unknown)).toThrow(/\/mount\/0\/writable/);

    const wrong = writeManifest({ mount: "/x", env: {} });
    expect(() => loadSandboxManifest(wrong)).toThrow(/\/mount/);
  });

  test("binds the main repository's git dir for a linked worktree", () => {
    const base = temp("key-sandbox-git-");
    const repository = join(base, "repository");
    const worktree = join(base, "worktree");
    mkdirSync(repository);
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
    const git = (args: readonly string[], cwd: string) =>
      execFileSync("git", args, {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    git(["init", "--quiet"], repository);
    git(["config", "user.email", "sandbox@example.com"], repository);
    git(["config", "user.name", "Sandbox"], repository);
    writeFileSync(join(repository, "first"), "first\n");
    git(["add", "first"], repository);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "first"], repository);
    git(["worktree", "add", "--quiet", "-b", "sandbox", worktree, "HEAD"], repository);

    const command = sandboxCommand(worktree, daemon, { mount: [], env: {} });
    const gitDir = join(repository, ".git");

    expect(indexOf(command, "--bind", worktree, worktree)).toBeGreaterThanOrEqual(0);
    expect(indexOf(command, "--bind", gitDir, gitDir)).toBeGreaterThanOrEqual(0);
  });

  test("binds no git dir when the cwd is not a repository", () => {
    const cwd = temp("key-sandbox-plain-");
    const command = sandboxCommand(cwd, daemon, { mount: [], env: {} });
    const binds = command.flatMap((token, index) =>
      token === "--bind" ? [command[index + 1]] : [],
    );

    expect(binds).toEqual([cwd]);
  });
});

/** A real connection that counts its closes; the daemon it names never starts. */
class CountingConnection extends Connection {
  closes = 0;
  constructor() {
    super({ command: [daemon] });
  }
  override close(): void {
    this.closes++;
    super.close();
  }
}

describe("sandboxEnv", () => {
  test("the connection closes on the abort signal, and not before", async () => {
    const controller = new AbortController();
    const connection = new CountingConnection();
    const env = new RemoteExecutionEnv({ connection, id: "counting", cwd: "/cwd" });
    sandboxEnv(
      7 as ConversationId,
      "/cwd",
      daemon,
      { mount: [], env: {} },
      withAbortSignal(controller.signal, context),
      () => ({ connection, env }),
    );

    expect(connection.closes).toBe(0);

    controller.abort();
    expect(connection.closes).toBe(1);
    await expect(connection.info()).rejects.toThrow("Connection closed");
  });
});
