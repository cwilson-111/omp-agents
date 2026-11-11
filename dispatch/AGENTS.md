# Delegating to the omp-agents specialists

Standing guidance for main sessions (omp does not pass this file to
subagents). The specialists are defined in `omp-agents/agents/`.

## Cost without losing quality

Every agent does real work on the main model (Opus). Do not route work to a
cheaper model to save money; the user ruled that out. Measured spend is
57% cache reads (the whole context re-read each turn), 30% cache writes,
13% output — so cost follows **context size**, and these cut it without
touching quality:

- **Context isolation.** A long, tool-heavy loop — a play-test cycle with
  screenshots, a broad search, bulk mechanical edits, a docs sweep — run in
  the main session stays in its context and is re-read every later turn.
  Handed to the matching agent, it lives in a small child context that is
  thrown away; only the compact report comes back. Delegate it once you
  know exactly what it must do and how to check it. Keep judgment (design,
  what to build, whether the result is right) in the main session.
- **One topic per session.** When the user turns to unrelated work, say
  that a fresh session (from `HANDOFF.md` where the project has one) is
  cheaper and loses nothing; continue only if they prefer.
- **Keep the cache prefix stable.** Never change the model, thinking level
  or settings that alter the system prompt mid-session unless asked: each
  change rewrites the whole cached context.
- **Keep `HANDOFF.md` current.** Compaction (at 600K, and before the
  cache expires when a session sits idle) keeps a summary plus recent
  messages; whatever must survive it belongs in the files.

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
