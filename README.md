# omp-agents

Task agents for [Oh My Pi](https://github.com/badlogic/pi-mono) (`omp`). Eight
specialists plus an orchestrator, written to be dispatched by name:

```json
{ "agent": "planner", "task": "..." }
```

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
| `backend` | yes | Engines, parsing, storage, CLI, background workers, packaging, CI. |
| `frontend` | yes | Tkinter windows, browser extensions, web pages, CLI output. Must verify by operating the real surface. |
| `ml-engineer` | yes | LLM and retrieval code: prompts, embeddings, vector stores, chunking, transcription. Treats model output as untrusted and measures rather than asserts. |
| `debugger` | yes | The symptom is known but the cause is not. Reproduces first, proves the cause by toggling it, then fixes. |
| `test-engineer` | yes | A real risk has no test, or an existing test pins wording instead of behaviour. Proves a regression test by running it against the unfixed code. |

**Check and ship**

| Agent | Edits? | Use it when |
|---|---|---|
| `arguer` | no | Before anything expensive or irreversible. Adversarial; every objection carries file:line evidence and a severity. |
| `security-reviewer` | no | Privilege boundaries, filesystem redirection, destructive operations, supply chain, extension permissions. |
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

**User scope** — available in every project on the machine:

```sh
git clone https://github.com/cwilson-111/omp-agents.git
mkdir -p ~/.omp/agent/agents
cp omp-agents/agents/*.md ~/.omp/agent/agents/
```

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
- No agent pins a `model`, so each inherits the parent session's model. To pin
  one, add a role alias to its frontmatter (`model: "@review"`) and map it under
  `modelRoles` in `~/.omp/agent/config.yml`, or set
  `task.agentModelOverrides.<name>` in settings. Several agents set
  `thinking-level: high`; models with no controllable effort ignore it.
- Read-only agents declare only `read, grep, glob, web_search` (plus `bash` for
  `security-reviewer`). They cannot edit even when asked to.
- Only `chief-of-staff` declares `spawns`. The rest cannot start subagents.
- `security-reviewer` and `frontend` name concrete subsystems from the author's
  own projects as worked examples. Adjust those paragraphs for your codebase —
  the discipline in the rest of each prompt is general.

## Adding an agent

Drop a `<name>.md` in `agents/`. Frontmatter needs at least `name` and
`description`; the body is the system prompt. A file missing either is skipped
with a warning and the rest still load. Every `.md` inside the directory is
parsed as an agent definition, which is why this README sits one level up.

Full frontmatter reference: `omp://task-agent-discovery.md`.
