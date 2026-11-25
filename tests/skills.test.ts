import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type Harness as OpenHarness,
  SystemEntry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, describe, expect, test } from "vitest";
import {
  createSkills,
  expandSkillCommand,
  externalSkillDirectories,
  formatSkillsForPrompt,
  loadSkills,
  type SkillPaths,
} from "../src/skills.ts";

const context = BACKGROUND_CONTEXT;
const temporary: string[] = [];
const opened: OpenHarness[] = [];

afterEach(async () => {
  for (const harness of opened.splice(0)) await harness.close(context);
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "key-skills-"));
  temporary.push(path);
  return path;
}

function paths(root: string): SkillPaths {
  return {
    user: join(root, "config", "key", "skills"),
    agents: join(root, "home", ".agents", "skills"),
    bundled: join(root, "package", "skills"),
  };
}

function skill(
  directory: string,
  name: string,
  description = `Description of ${name}`,
  body = `# ${name}\n\nFull instructions for ${name}.`,
  extra = "",
): string {
  const file = join(directory, "SKILL.md");
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`);
  return file;
}

describe("skill discovery", () => {
  test("loads user and Agent Skills locations through the repository root, nearest project first", () => {
    const root = temp();
    const repository = join(root, "repo");
    const cwd = join(repository, "packages", "app");
    const configured = paths(root);
    mkdirSync(join(repository, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    skill(join(configured.user, "user"), "user");
    skill(join(configured.agents, "agents-user"), "agents-user");
    skill(join(repository, ".agents", "skills", "project"), "project");
    skill(join(cwd, ".agents", "skills", "near"), "near");
    skill(join(root, ".agents", "skills", "outside"), "outside");
    skill(join(cwd, ".key", "skills", "key-only"), "key-only");
    skill(join(cwd, ".pi", "skills", "pi-only"), "pi-only");
    skill(join(configured.bundled, "bundled"), "bundled");

    const loaded = loadSkills(cwd, configured);
    expect(loaded.skills.map(({ name }) => name)).toEqual([
      "user",
      "agents-user",
      "near",
      "project",
      "bundled",
    ]);
    expect(loaded.diagnostics).toEqual([]);
    expect(externalSkillDirectories(cwd, configured)).toEqual([
      configured.user,
      configured.agents,
      join(repository, "packages", ".agents", "skills"),
      join(repository, ".agents", "skills"),
      configured.bundled,
    ]);
  });

  test("a user or project skill shadows the bundled one of the same name", () => {
    const root = temp();
    const repository = join(root, "repo");
    const cwd = join(repository, "app");
    const configured = paths(root);
    mkdirSync(join(repository, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const bundled = skill(join(configured.bundled, "review"), "review", "Bundled review");
    skill(join(configured.bundled, "compose"), "compose", "Bundled compose");
    skill(join(configured.user, "review"), "review", "User review");
    const userReview = join(configured.user, "review", "SKILL.md");

    const loaded = loadSkills(cwd, configured);
    expect(loaded.skills.map(({ name, description }) => ({ name, description }))).toEqual([
      { name: "review", description: "User review" },
      { name: "compose", description: "Bundled compose" },
    ]);
    expect(loaded.diagnostics).toEqual([
      { path: bundled, message: `name "review" collision; ${userReview} wins` },
    ]);

    skill(join(cwd, ".agents", "skills", "compose"), "compose", "Project compose");
    expect(loadSkills(cwd, configured).skills.map(({ description }) => description)).toEqual([
      "User review",
      "Project compose",
    ]);
  });

  test("the bundled collection mounts read-only unless the checkout already holds it", () => {
    const root = temp();
    const configured = paths(root);
    mkdirSync(configured.bundled, { recursive: true });

    expect(externalSkillDirectories(join(root, "checkout"), configured)).toContain(
      configured.bundled,
    );
    expect(externalSkillDirectories(join(root, "package"), configured)).not.toContain(
      configured.bundled,
    );
  });

  test("a skill root stops recursion, and a name collision keeps the first skill", () => {
    const root = temp();
    const configured = paths(root);
    skill(join(configured.user, "shared"), "shared", "User winner");
    skill(join(configured.user, "shared", "nested"), "nested");
    skill(join(configured.agents, "shared"), "shared", "Agent loser");

    const loaded = loadSkills(root, configured);
    expect(loaded.skills.map(({ name, description }) => ({ name, description }))).toEqual([
      { name: "shared", description: "User winner" },
    ]);
    expect(loaded.diagnostics).toHaveLength(1);
    expect(loaded.diagnostics[0]?.message).toContain("collision");
  });

  test("invalid skills diagnose without hiding valid ones, and explicit-only skills leave the catalog", () => {
    const root = temp();
    const configured = paths(root);
    const valid = skill(join(configured.user, "valid"), "valid");
    skill(
      join(configured.user, "hidden"),
      "hidden",
      "Explicit only",
      "Hidden body",
      "disable-model-invocation: true\n",
    );
    mkdirSync(join(configured.user, "missing"), { recursive: true });
    writeFileSync(join(configured.user, "missing", "SKILL.md"), "---\nname: missing\n---\nBody\n");
    skill(join(configured.user, "bad name"), "bad name");

    const loaded = loadSkills(root, configured);
    expect(loaded.skills.map(({ name }) => name)).toEqual(["bad name", "hidden", "valid"]);
    expect(loaded.diagnostics.map(({ message }) => message)).toEqual([
      "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)",
      "description is required",
    ]);
    const prompt = formatSkillsForPrompt(loaded.skills);
    expect(prompt).toContain("<name>valid</name>");
    expect(prompt).toContain(valid);
    expect(prompt).not.toContain("hidden");
    expect(prompt).toContain("bad name");
    expect(prompt).not.toContain("Full instructions");
  });
});

describe("explicit skill invocation", () => {
  test("loads the body without frontmatter, names its base directory, and appends arguments", () => {
    const root = temp();
    const configured = paths(root);
    const file = skill(
      join(root, ".agents", "skills", "delegate"),
      "delegate",
      "Delegate work",
      "# Delegate\n\nRead references/workflow.md first.",
      "disable-model-invocation: true\n",
    );

    const expanded = expandSkillCommand(root, "/skill:delegate implement this", configured);
    expect(expanded).toBe(
      `<skill name="delegate" location="${file}">\n` +
        `References are relative to ${dirname(file)}.\n\n` +
        "# Delegate\n\nRead references/workflow.md first.\n</skill>\n\nimplement this",
    );
    expect(expanded).not.toContain("disable-model-invocation");
    expect(expandSkillCommand(root, "/skill:unknown hello", configured)).toBe(
      "/skill:unknown hello",
    );
    expect(expandSkillCommand(root, "ordinary prompt", configured)).toBe("ordinary prompt");
  });
});

describe("the durable skills section", () => {
  test("the next request sees a changed catalog as a system delta, without injecting the body", async () => {
    const root = temp();
    const cwd = join(root, "repo");
    const configured = paths(root);
    mkdirSync(cwd, { recursive: true });
    const file = skill(join(cwd, ".agents", "skills", "review"), "review", "Review changes");
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const prompts: (string | undefined)[] = [];
    faux.setResponses([
      (request) => {
        prompts.push(getCurrentSystemPrompt(request.messages));
        return fauxAssistantMessage("first");
      },
      (request) => {
        prompts.push(getCurrentSystemPrompt(request.messages));
        return fauxAssistantMessage("second");
      },
    ]);
    const registry = createRegistry();
    registry.install(createSkills(configured));
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry, env: () => new NodeExecutionEnv({ cwd }) },
      context,
    );
    opened.push(harness);
    const conversation = await harness.root(context, {
      agent: { model: { provider: "faux", modelId: "faux-1" }, cwd },
    });

    await (await conversation.submit({ type: "input", content: "one" }, context)).wait(context);
    expect(prompts[0]).toContain("<name>review</name>");
    expect(prompts[0]).toContain("Review changes");
    expect(prompts[0]).toContain(file);
    expect(prompts[0]).not.toContain("Full instructions for review");

    skill(dirname(file), "review", "Review diffs carefully");
    await (await conversation.submit({ type: "input", content: "two" }, context)).wait(context);
    expect(prompts[1]).toContain("Review diffs carefully");
    const systems = (await conversation.context(context)).entries.filter(SystemEntry.is);
    expect(systems).toHaveLength(2);
    const delta = systems[1]?.model?.[0];
    if (delta?.role !== "system") throw new Error("second request has no system delta");
    expect(delta.sections?.skills).toContain("Review diffs carefully");
    expect(delta.sections?.skills).not.toContain("Review changes");
  });
});
