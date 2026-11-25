---

name: authoring-skills
description: Write a new Agent Skill for Key — frontmatter rules, where skills are discovered, and how bodies load on demand.
---

# Authoring a Key skill

A skill is a directory holding a `SKILL.md`: YAML frontmatter for routing, a
markdown body for what to do. Key advertises only the name, description, and
path; the body is read with the `read` tool when a task matches.

## Frontmatter

```markdown
---

name: review-diff
description: Review a git diff for correctness, regressions, and missing tests.
---
```

- `description` is required and at most 1024 characters. Write it as the
  condition that selects the skill, not as a summary of its contents.
- `name` is optional; without it the skill takes its directory name. It must be
  at most 64 characters of lowercase `a-z`, `0-9`, and hyphens, with no leading,
  trailing, or doubled hyphen.
- `disable-model-invocation: true` keeps the skill out of the catalog while
  leaving `/skill:<name>` working for a human who invokes it by hand.

## Discovery

Key reads these locations on every request, first match per name winning:

1. `$XDG_CONFIG_HOME/key/skills/` — the user's own collection.
2. `~/.agents/skills/` — the shared Agent Skills location.
3. `.agents/skills/` from the working directory up to the git root, nearest first.
4. The collection bundled with the Key install.

A directory containing `SKILL.md` is a completed skill: discovery stops there and
does not look inside. Other directories recurse, skipping hidden entries,
`node_modules`, and anything `.gitignore`, `.ignore`, or `.fdignore` excludes.
A markdown file sitting directly in a discovery directory also loads as a skill
when its frontmatter has a description.

Because the first name wins, saving a skill to a user or project location
overrides the bundled one of the same name. Key reports the losing file — a
name collision is a diagnostic on stderr, not a silent drop.

## Body

Everything after the frontmatter is the instruction text the model receives,
with the skill's directory named so relative mentions resolve. Put scripts and
references next to `SKILL.md` and refer to them relatively — Key mounts skill
directories outside the working directory read-only into the conversation's
sandbox, so bundled references stay visible without being writable.

Explicit invocation, `/skill:<name> [arguments]`, wraps the body in a `<skill>`
element and appends the arguments after it.
