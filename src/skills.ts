// Agent Skills: the catalog is re-read for every request, while bodies load through read or /skill.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";
import ignore from "ignore";
import { parse } from "yaml";
import { configDir } from "./config.ts";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

export type SkillPaths = {
  /** Key's XDG user configuration. */
  readonly user: string;
  /** The Agent Skills user location, normally ~/.agents/skills. */
  readonly agents: string;
};

export type Skill = {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly baseDir: string;
  readonly disableModelInvocation: boolean;
};

export type SkillDiagnostic = {
  readonly path: string;
  readonly message: string;
};

export type LoadSkillsResult = {
  readonly skills: readonly Skill[];
  readonly diagnostics: readonly SkillDiagnostic[];
};

export function defaultSkillPaths(): SkillPaths {
  return { user: join(configDir(), "skills"), agents: join(homedir(), ".agents", "skills") };
}

function gitRoot(cwd: string): string | undefined {
  for (let dir = cwd; ; ) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** User locations first, then project .agents directories from nearest to farthest. */
export function skillDirectories(
  cwd: string,
  paths: SkillPaths = defaultSkillPaths(),
): readonly string[] {
  const root = resolve(cwd);
  const repository = gitRoot(root);
  const directories = [resolve(paths.user), resolve(paths.agents)];
  for (let dir = root; ; ) {
    directories.push(join(dir, ".agents", "skills"));
    if (dir === repository) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...new Set(directories)];
}

/** Skill resources outside the writable checkout must enter its sandbox read-only. */
export function externalSkillDirectories(
  cwd: string,
  paths: SkillPaths = defaultSkillPaths(),
): readonly string[] {
  const root = resolve(cwd);
  return skillDirectories(root, paths).filter((directory) => {
    const rel = relative(root, directory);
    return rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  });
}

function posix(path: string): string {
  return path.split(sep).join("/");
}

function ignorePattern(line: string, prefix: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) return undefined;
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  return `${negated ? "!" : ""}${prefix}${pattern}`;
}

function addIgnoreRules(matcher: IgnoreMatcher, dir: string, root: string): void {
  const rel = relative(root, dir);
  const prefix = rel === "" ? "" : `${posix(rel)}/`;
  for (const name of IGNORE_FILES) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const patterns = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => ignorePattern(line, prefix))
      .filter((line): line is string => line !== undefined);
    matcher.add(patterns);
  }
}

function frontmatter(content: string): {
  readonly fields: Record<string, unknown>;
  readonly body: string;
} {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---")) return { fields: {}, body: normalized };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { fields: {}, body: normalized };
  const fields = (parse(normalized.slice(4, end)) ?? {}) as Record<string, unknown>;
  return { fields, body: normalized.slice(end + 4).trim() };
}

function nameErrors(name: string): readonly string[] {
  const errors: string[] = [];
  if (name.length > MAX_NAME_LENGTH)
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  if (!/^[a-z0-9-]+$/.test(name))
    errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
  if (name.startsWith("-") || name.endsWith("-"))
    errors.push("name must not start or end with a hyphen");
  if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
  return errors;
}

function loadSkill(path: string): {
  readonly skill?: Skill;
  readonly diagnostics: SkillDiagnostic[];
} {
  const declared = basename(path) === "SKILL.md";
  let parsed: ReturnType<typeof frontmatter>;
  try {
    parsed = frontmatter(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      diagnostics: [{ path, message: error instanceof Error ? error.message : String(error) }],
    };
  }
  const description = parsed.fields.description;
  const hasDescription = typeof description === "string" && description.trim() !== "";
  if (!declared && !hasDescription) return { diagnostics: [] };
  const diagnostics: SkillDiagnostic[] = [];
  if (!hasDescription) diagnostics.push({ path, message: "description is required" });
  else if (description.length > MAX_DESCRIPTION_LENGTH)
    diagnostics.push({
      path,
      message: `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
    });
  const declaredName = parsed.fields.name;
  const name =
    typeof declaredName === "string" && declaredName !== ""
      ? declaredName
      : basename(dirname(path));
  diagnostics.push(...nameErrors(name).map((message) => ({ path, message })));
  if (!hasDescription) return { diagnostics };
  return {
    skill: {
      name,
      description,
      filePath: path,
      baseDir: dirname(path),
      disableModelInvocation: parsed.fields["disable-model-invocation"] === true,
    },
    diagnostics,
  };
}

/**
 * A directory with SKILL.md is one skill root; otherwise recurse, skipping hidden and ignored entries.
 */
export function loadSkillsFromDir(dir: string): LoadSkillsResult {
  if (!existsSync(dir)) return { skills: [], diagnostics: [] };
  return loadDirectory(dir, dir, true, ignore());
}

function loadDirectory(
  dir: string,
  root: string,
  rootFiles: boolean,
  matcher: IgnoreMatcher,
): LoadSkillsResult {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  addIgnoreRules(matcher, dir, root);
  const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const declared = entries.find((entry) => entry.name === "SKILL.md");
  if (declared !== undefined) {
    const path = join(dir, declared.name);
    const ignored = matcher.ignores(posix(relative(root, path)));
    if (!ignored && (declared.isFile() || (declared.isSymbolicLink() && statSync(path).isFile()))) {
      const loaded = loadSkill(path);
      if (loaded.skill !== undefined) skills.push(loaded.skill);
      diagnostics.push(...loaded.diagnostics);
    }
    return { skills, diagnostics };
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    const directory =
      entry.isDirectory() || (entry.isSymbolicLink() && statSync(path).isDirectory());
    const file = entry.isFile() || (entry.isSymbolicLink() && statSync(path).isFile());
    const rel = posix(relative(root, path));
    if (matcher.ignores(directory ? `${rel}/` : rel)) continue;
    if (directory) {
      const loaded = loadDirectory(path, root, false, matcher);
      skills.push(...loaded.skills);
      diagnostics.push(...loaded.diagnostics);
    } else if (file && rootFiles && entry.name.endsWith(".md")) {
      const loaded = loadSkill(path);
      if (loaded.skill !== undefined) skills.push(loaded.skill);
      diagnostics.push(...loaded.diagnostics);
    }
  }
  return { skills, diagnostics };
}

export function loadSkills(cwd: string, paths: SkillPaths = defaultSkillPaths()): LoadSkillsResult {
  const skills = new Map<string, Skill>();
  const files = new Set<string>();
  const diagnostics: SkillDiagnostic[] = [];
  for (const directory of skillDirectories(cwd, paths)) {
    const loaded = loadSkillsFromDir(directory);
    diagnostics.push(...loaded.diagnostics);
    for (const skill of loaded.skills) {
      const file = realpathSync(skill.filePath);
      if (files.has(file)) continue;
      const collision = skills.get(skill.name);
      if (collision !== undefined) {
        diagnostics.push({
          path: skill.filePath,
          message: `name "${skill.name}" collision; ${collision.filePath} wins`,
        });
      } else {
        skills.set(skill.name, skill);
        files.add(file);
      }
    }
  }
  return { skills: [...skills.values()], diagnostics };
}

function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Only routing metadata enters the prompt; the model reads the body when it selects a skill. */
export function formatSkillsForPrompt(skills: readonly Skill[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";
  return [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
    "",
    "<available_skills>",
    ...visible.flatMap((skill) => [
      "  <skill>",
      `    <name>${xml(skill.name)}</name>`,
      `    <description>${xml(skill.description)}</description>`,
      `    <location>${xml(skill.filePath)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

/** Expand pi-compatible command syntax without adopting pi's resource locations. */
export function expandSkillCommand(
  cwd: string,
  text: string,
  paths: SkillPaths = defaultSkillPaths(),
): string {
  if (!text.startsWith("/skill:")) return text;
  const space = text.indexOf(" ");
  const name = space === -1 ? text.slice(7) : text.slice(7, space);
  const skill = loadSkills(cwd, paths).skills.find((candidate) => candidate.name === name);
  if (skill === undefined) return text;
  const body = frontmatter(readFileSync(skill.filePath, "utf8")).body.trim();
  const block =
    `<skill name="${xml(skill.name)}" location="${xml(skill.filePath)}">\n` +
    `References are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  const args = space === -1 ? "" : text.slice(space + 1).trim();
  return args === "" ? block : `${block}\n\n${args}`;
}

export function createSkills(paths: SkillPaths = defaultSkillPaths()) {
  return defineExtension({
    name: "skills",
    sections: [
      section("skills", ({ agent }) => {
        if (agent.cwd === undefined) return undefined;
        const loaded = loadSkills(agent.cwd, paths);
        for (const diagnostic of loaded.diagnostics)
          console.error(`key: skill ${diagnostic.path}: ${diagnostic.message}`);
        return formatSkillsForPrompt(loaded.skills) || undefined;
      }),
    ],
  });
}
