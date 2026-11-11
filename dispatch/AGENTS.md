# Delegating to the omp-agents specialists

Standing guidance for main sessions (omp does not pass this file to
subagents). The specialists are defined in `omp-agents/agents/`.

## Cost tiers

The main session runs on Opus; agents run cheaper where their work is
checked by running it (roles in `~/.omp/agent/config.yml`):

- `@build` (Sonnet): `backend`, `frontend`, `test-engineer`, `docs-writer`,
  `ml-engineer`, `planner`.
- `@smol` (Haiku): `scout`, `sonic`.
- Opus (inherited): `architect`, `arguer`, `judge`, `security-reviewer`,
  `debugger`, `chief-of-staff`, `release-manager`, `reviewer`.

So a long, tool-heavy loop — a play-test cycle with screenshots, a broad
search, bulk mechanical edits, a docs sweep — is cheaper handed to the
matching agent than run in the main session, once you know exactly what it
must do and how to check it. Keep judgment (design, what to build, whether
the result is right) in the main session.

## Do it yourself, or delegate?

Delegation costs a blank-slate child re-reading what you already know. Do
the work yourself when it is one obvious change, a question you can answer
from context, or a step that needs the user in the loop.

Delegate when one of these holds:

| Trigger | Agent |
|---|---|
| Two or more independent slices could run at once | the matching builders, in one batch |
| Unfamiliar code you need mapped while you keep working | `scout` |
| A symptom whose cause is not obvious after one look | `debugger` |
| Before anything irreversible: a migration of saved data, a release, a publish, a bulk deletion, a security boundary | `arguer` on the plan, first |
| A change touching auth, remotes/endpoints, purchases, privilege, parsers of untrusted input, or secrets | `security-reviewer` after it lands |
| Several viable designs for a cross-cutting change | `architect` (then `judge` only if `arguer` and the plan genuinely conflict) |
| A goal whose order is unclear across many files or sessions | `planner` |
| Docs drifted across several files, or after another agent's change | `docs-writer` |
| A real risk with no test, in a project that has a test suite | `test-engineer` |
| Shipping a version | `release-manager` |
| A large multi-part job that should run while you handle something else | `chief-of-staff` |

Builders by surface: `frontend` for anything a person sees (app windows,
web, extensions, game UI), `backend` for everything behind it (logic,
saves, server code, CLI, CI), `ml-engineer` for model-bearing code.

## Every dispatch carries

- **The project root path** and "read its `AGENTS.md` and `HANDOFF.md`
  first" — children do not receive `AGENTS.md`, and sessions often start in
  a folder holding several repos.
- The full requirement, the acceptance criterion, and the files it must not
  touch.
- Anything only the user can do or decide, already resolved. Children
  cannot ask the user.

## Shared singletons

One child at a time may drive an open game-engine place (Roblox Studio), a
dev server, a database, a browser profile or a device. Never run two
children that deploy into, restart or reseed the same one in parallel; and
never let any child deploy a test build into Studio unless the user has
confirmed they are not publishing.
