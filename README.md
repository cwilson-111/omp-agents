# omp-agents

Task agents for [Oh My Pi](https://github.com/badlogic/pi-mono) (`omp`): twelve
specialists plus an orchestrator, written to be dispatched by name, and a
dispatch guide that tells the main session when to use which.

```json
{ "agent": "planner", "task": "..." }
```

## How they work on any project

The agents carry discipline, not project facts. Each one starts with the
same **Orient first** step: find the project root of the files in its task
(the nearest `.git`), read that root's `AGENTS.md`, `CLAUDE.md` and
`HANDOFF.md`, then its build files, and follow them over its own defaults.

That step exists because omp gives subagents **no `AGENTS.md`** (it strips
every file of that name from their context) and sessions often start in a
folder holding several repos, so nothing project-specific arrives on its
own. Put each project's conventions, verification ritual and traps in its
own `AGENTS.md`: a main session started there loads it automatically, and
every agent reads it explicitly.

MCP tools are inherited whatever an agent's `tools:` list says, so an agent
working on a game can drive the engine's MCP server (e.g. Roblox Studio)
to play-test its change.

## Dispatch guide

`dispatch/AGENTS.md` is standing guidance for **main** sessions: when to do
work directly versus delegate, which agent each trigger calls for, what
every dispatch must carry (the project root, the acceptance criterion,
user-only steps resolved), and the rule that one child at a time drives a
shared singleton such as an open Studio place or a dev server. Install it
as the user-level `~/.omp/agent/AGENTS.md` (below); subagents never see it,
which is right, since dispatching is the parent's job.

## Roster

Thirteen agents, grouped by what they are for.

**Direct and decide**

| Agent | Edits? | Use it when |
|---|---|---|
| `chief-of-staff` | yes | The work spans several files or disciplines and needs decomposing, dispatching and integrating. It is the only agent that can spawn the others. |
| `planner` | no | The goal is clear but the sequence is not. Returns ordered phases, each with a falsifiable acceptance criterion and a verification command. |
| `architect` | no | Two or more designs are defensible, or a cross-cutting interface/schema is changing. Returns one decision plus the contract and the migration. |
| `judge` | no | Two positions are both defensible and someone has to rule. Returns structured output with a confidence level and what would reverse it. |

**Build**

| Agent | Edits? | Use it when |
|---|---|---|
| `backend` | yes | Engines, parsing, storage and saves, server/game logic, CLI, background workers, packaging, CI. |
| `frontend` | yes | App windows, web pages, browser extensions, game UI, CLI output. Must verify by operating the real surface. |
| `ml-engineer` | yes | LLM and retrieval code: prompts, embeddings, vector stores, chunking, transcription. Treats model output as untrusted and measures rather than asserts. |
| `debugger` | yes | The symptom is known but the cause is not. Reproduces first, proves the cause by toggling it, then fixes. |
| `test-engineer` | yes | A real risk has no test, or an existing test pins wording instead of behaviour. Proves a regression test by running it against the unfixed code. |

**Check and ship**

| Agent | Edits? | Use it when |
|---|---|---|
| `arguer` | no | Before anything expensive or irreversible. Adversarial; every objection carries file:line evidence and a severity. |
| `security-reviewer` | no | Privilege boundaries, untrusted parsers, client/server trust, filesystem redirection, destructive operations, secrets, supply chain, extension permissions. |
| `docs-writer` | yes | Markdown has drifted from the code. The counterpart to `arguer`, which finds drift but cannot fix it. |
| `release-manager` | yes | Shipping a version: bump everywhere, date the changelog, update packaging manifests, tag, watch CI, verify an artifact. |

Unchanged and still available from OMP's bundled set: `scout`, `reviewer`,
`task`, `sonic`.

## Usage budget: stop at 99%, hand off, resume

This is a **hook**, not an agent — deliberately. An agent is a prompt: it has
no scheduler, cannot wake itself, cannot see your quota, and would spend the
very budget it was asked to watch. A hook runs in-process on real events and
can block tool calls, which is the only thing here that can actually halt work.

```sh
./hooks/install.sh                          # the hook + a config placeholder
./hooks/install.sh --resume ~/path/to/proj  # + an hourly launchd resume job
```

**How it decides.** It sums `usage.cost.total` from the live session logs in
`~/.omp/agent/sessions/` — subagents included, since the quota is per account —
over a rolling window, against a ceiling you set in
`~/.omp/agent/usage-budget.json`:

```json
{ "windowHours": 5, "budgetUsd": 60, "warnAt": 0.8, "stopAt": 0.99, "handoffPath": "HANDOFF.md" }
```

It does **not** read `~/.omp/stats.db`. That is a cache `omp stats` syncs from
the same logs, and it lags them: measured, its newest row was from 21:42 while
the logs already held requests from 06:34 the next morning. A budget read from
it would miss exactly the spend it exists to catch.

**What it does.**

| Spend | Effect |
|---|---|
| below `warnAt` | nothing |
| ≥ `warnAt` | one message: finish and verify what's started, keep `HANDOFF.md` current. Blocks nothing. |
| ≥ `stopAt` | tells the agent to write `HANDOFF.md`; blocks every tool except `read`, `write`, `edit`, `todo`, `glob`, `grep` — and those only for the handoff |
| handoff written | blocks everything |

Run `/budget` in any session to see where you stand.

**Resuming.** The `--resume` job runs hourly — not at a fixed time, because a
rolling window has no reset moment; room returns gradually as old spend ages
out. Each run checks `/budget` and `HANDOFF.md` first and exits immediately
unless there is both room and an unfinished next action. The hook loads in
that session too, so even a run that ignores its prompt is still halted.
`hooks/HANDOFF.template.md` is the shape the handoff should take.

**Limits, stated plainly.** This measures spend against a number *you* choose;
nothing local exposes the provider's real remaining quota, so set `budgetUsd`
and `windowHours` to match your plan. The config written by the installer is a
placeholder. With no config, or an unparseable one, the hook does nothing —
failing open is right for a tool whose failure mode is refusing to let you work.

## Install

Pick one scope.

**User scope** — available in every project on the machine. Symlinks track
the repo, so `git pull` updates both:

```sh
git clone https://github.com/cwilson-111/omp-agents.git
ln -s "$PWD/omp-agents/agents" ~/.omp/agent/agents
ln -s "$PWD/omp-agents/dispatch/AGENTS.md" ~/.omp/agent/AGENTS.md
```

If `~/.omp/agent/AGENTS.md` already exists, append the dispatch guide to it
instead of replacing it.

Windows PowerShell:

```powershell
git clone https://github.com/cwilson-111/omp-agents.git
New-Item -ItemType Directory -Force "$HOME\.omp\agent\agents" | Out-Null
Copy-Item omp-agents\agents\*.md "$HOME\.omp\agent\agents\"
```

**Project scope** — only inside one project tree, and it wins over user scope:

```sh
mkdir -p <project>/.omp/agents
cp omp-agents/agents/*.md <project>/.omp/agents/
```

To track updates instead of copying, symlink the directory
(`ln -s "$PWD/omp-agents/agents" ~/.omp/agent/agents`; on Windows,
`mklink /D "%USERPROFILE%\.omp\agent\agents" "...\omp-agents\agents"` from an
elevated prompt) and `git pull` to update.

Verify the install by dispatching one:

```json
{ "agent": "arguer", "task": "Attack the premise that this repo's README is accurate." }
```

A name that did not load fails preflight with `Unknown agent "..."`.

## Notes

- **`security-reviewer` shadows OMP's bundled agent of the same name.**
  Discovery is first-wins by exact name, and project scope beats user scope
  beats bundled. Delete `security-reviewer.md` to fall back to the bundled one,
  or rename it (change the `name:` field too) to keep both.
- **Cost tiers.** The build agents (`backend`, `frontend`, `test-engineer`,
  `docs-writer`, `ml-engineer`, `planner`) declare `model: "@build"`; the
  judgment agents (`architect`, `arguer`, `judge`, `security-reviewer`,
  `debugger`, `chief-of-staff`, `release-manager`) pin nothing and inherit
  the parent's model. Map the roles in `~/.omp/agent/config.yml`, and send
  the bundled `scout`/`sonic` to the cheap tier with an override:

  ```yaml
  modelRoles:
    default: anthropic/claude-opus-5-5:high
    build: anthropic/claude-sonnet-5-5:high   # half Opus's price
    smol: anthropic/claude-haiku-5-5          # ~1/40; also titles, memory
  task:
    agentModelOverrides: { scout: "@smol", sonic: "@smol" }
  ```

  Define the `build` role before using the build agents. An unset `smol`
  inherits `default` (omp's model docs), so background work runs on the main
  model until it is set. Several agents set `thinking-level: high`; models
  with no controllable effort ignore it.
- Read-only agents declare only `read, grep, glob, web_search` (plus `bash` for
  `security-reviewer`). They cannot edit even when asked to.
- Only `chief-of-staff` declares `spawns`. The rest cannot start subagents.
- No agent names a project. Project facts live in each project's `AGENTS.md`
  (this author's: `Storage-Scanner/`, `gmail-summarizer-extension/`,
  `roblox-game/`), which the agents read during **Orient first**.
- `frontend`, `backend`, `debugger`, `test-engineer` and `ml-engineer` declare
  `eval`: browser automation (`browser`) is a prelude inside `eval`, not a
  tool of its own.

## Adding an agent

Drop a `<name>.md` in `agents/`. Frontmatter needs at least `name` and
`description`; the body is the system prompt. A file missing either is skipped
with a warning and the rest still load. Every `.md` inside the directory is
parsed as an agent definition, which is why this README sits one level up.

Full frontmatter reference: `omp://task-agent-discovery.md`.
