---
name: opsx-autopilot
description: Auto-routing and chaining for the OpenSpec opsx workflow (intent → skill; planning → apply → self-review → archive)
alwaysApply: true
---

# opsx-autopilot

- This project uses OpenSpec (`openspec/`). Do NOT wait for the user to type `/opsx-*` commands.
- Intent routing: non-trivial build/fix/plan request → read `skill://openspec-propose` and follow it. Exploratory/uncertain idea → `skill://openspec-explore`. Trivial fix (typo, one-liner, no spec impact) → just do it, no change scaffold.
- If an OpenSpec skill file is missing (profile/core-vs-expanded), fall back to the CLI the skill would have driven (`openspec new change`, `openspec instructions <artifact> --change <id> --json`) — never hand-craft files under `openspec/`.
- Messages prefixed `[opsx-autopilot]` are injected user directives: treat them as the user request that authorizes the next workflow step (this satisfies propose's planning boundary, which requires a new user request after artifacts).
- Archive is user-gated, spec-sync is not: when a change is ready, self-review first (verify skill if present, project tests/build, browser tool for UI changes), then ASK the user before archiving. At the archive skill's sync prompt always choose "Sync now (recommended)" and run the inline sync automatically — never ask the user about syncing.
- Never auto-select among multiple active changes; ask.
- Never edit generated files under `.omp/skills/` or `.omp/commands/`; `openspec update` regenerates them.
