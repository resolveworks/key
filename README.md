# Key

Key is my personal harness for coding agents: a durable host and a terminal
client for starting, steering, and observing work. It is a serious playground,
built to evolve with me as I learn how I want to direct agents.

## The idea

Key organizes work as cascades of fresh contexts. A conversation can delegate
independent implementation to workers or start researchers to investigate
questions. When the conversation finishes, a fresh successor takes over, waits
for those children to settle, receives their results, and decides what happens
next. The cascade continues for as long as it keeps starting children.

Information flows forward rather than accumulating in one ever-growing
conversation. A successor starts with the work and findings before it, not a
copy of every transcript.

## Host and clients

The host owns durable sessions and the work running through them. Clients are
ways into that host, not owners of the work themselves. The terminal is the
client I use now; the same architecture leaves room for mobile and automated
clients, including clients that propose new work.

The implementation will keep changing. The direction is a harness that remains
mine to optimize and direct.

## Usage

Key needs Node 22.19+, pnpm, and bubblewrap.

```sh
pnpm add -g @resolveworks/key
key serve    # own the session and serve the graph
key          # connect the client from another terminal
```

Key keeps configuration in `$XDG_CONFIG_HOME/key` and data in `$XDG_DATA_HOME/key`, following the
XDG base directory spec:

| Variable          | Default                      | What it moves                                                       |
| ----------------- | ---------------------------- | ------------------------------------------------------------------- |
| `XDG_CONFIG_HOME` | `~/.config`                  | `key/auth.json`, `key/sandbox.json`, and `key/skills/`              |
| `XDG_DATA_HOME`   | `~/.local/share`             | `key/session.sqlite` and `key/worktrees/`                           |
| `KEY_PORT`        | `7317`                       | the host's port; the client follows unless `KEY_HOST` names another |
| `KEY_BIND`        | `127.0.0.1`                  | the host's interface                                                |
| `KEY_HOST`        | `http://127.0.0.1:$KEY_PORT` | the client's host                                                   |

### Skills

Key discovers [Agent Skills](https://agentskills.io/specification) directories containing
`SKILL.md` in these locations:

- `$XDG_CONFIG_HOME/key/skills/` (`~/.config/key/skills/` by default)
- `~/.agents/skills/`
- `.agents/skills/` in the working directory and its ancestors, stopping at the repository root
- the `skills/` directory shipped with the package, so an install is never empty

The first skill of a name wins, so a user or project skill shadows the bundled one of the same
name; Key reports the losing file on stderr.

The system prompt advertises each skill's name, description, and path. The model reads the full
instructions only when it selects one. Use `/skill:name [arguments]` to invoke one explicitly,
including a skill whose frontmatter sets `disable-model-invocation: true`. Skill discovery is
repeated for each request, so edits take effect on the next request.

Skill directories outside the conversation's working directory are mounted into its sandbox
read-only, the bundled collection among them. Bundled references and scripts therefore use the
same absolute paths shown in the system prompt.

Key also mounts its data directory read-only into every conversation's sandbox as `KEY_DATA_DIR`,
so the bundled `session-history` skill can query `session.sqlite` directly while the host keeps
writing it. That mount is for reading: replies and edits still go through the host.

### Host as a systemd user service

```ini
[Unit]
Description=Key host

[Service]
ExecStart=%h/.local/share/pnpm/bin/key serve
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now key
```

## Development

From a checkout:

```sh
pnpm install
pnpm serve
```

In another terminal, connect the client:

```sh
pnpm client
```

`pnpm build` compiles the published artifact into `dist/`; `pnpm serve` and `pnpm client` run the
source directly. `pnpm build:env` builds the pi checkout beside this repository and puts its
daemon where local sessions look. The published package ships pi's daemon already.

```sh
pnpm check
pnpm test
```

Behavior tests live under `tests/`. Git hooks live in `.githooks`:

```sh
git config core.hooksPath .githooks
```
