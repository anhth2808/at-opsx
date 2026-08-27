---
name: opsx-autopilot
description: Auto-routing and chaining for the OpenSpec opsx workflow (intent → skill; planning → apply → self-review → archive; defer → GitHub issue)
alwaysApply: true
---
<!-- opsx-autopilot-rule: v2 -->

# opsx-autopilot

- This project uses OpenSpec (`openspec/`). Do NOT wait for the user to type `/opsx-*` commands.
- Intent routing: non-trivial build/fix/plan request → read `skill://openspec-propose` and follow it. Exploratory/uncertain idea → `skill://openspec-explore`. Trivial fix (typo, one-liner, no spec impact) → just do it, no change scaffold. **Defer intent**: the user wants the task saved for later, not done now — phrases like "để sau", "tạo issue", "log issue", "backlog", "not now", "TODO", "lưu lại task này" → take the **GitHub-issue path** (bullet below); do NOT scaffold `openspec/changes/`, do NOT modify code. Ambiguous between "do now" and "later" → ask the user one short question.
- **GitHub-issue creation procedure** (the defer path — run `gh` via the normal bash tool):
  1. **Preflight**: the project must have a GitHub remote (`git remote get-url origin` — accept SSH aliases like `git@github-personal:owner/repo.git`; parse owner/repo from the tail) AND `gh auth status` must exit 0. If either is missing, tell the user exactly what is missing (with a `gh auth login` / add-remote hint) and stop. Never create an issue in any other repo.
  2. **Draft**: imperative title < 72 chars; body follows this template. Read the related repo files before writing acceptance criteria (normal code-reading tools).
     ```
     ## Context
     ## Problem / Proposed behavior
     ## Acceptance criteria
     - [ ] ...
     ## Notes (related files, refs)
     ```
  3. **Confirm**: show the full title + body draft in chat → **STOP and wait for the user's reply — do not run any mutating `gh` command before the user agrees.** If the user declines, drop it and do not ask again.
  4. **Create**: write the body to a temp file (OS temp dir), then `gh issue create --repo <owner>/<repo> --title "<title>" --body-file <file>` (avoids inline quoting). No labels/assignees unless the user asks; if a label is requested, check `gh label list` first — a missing label → ask the user, never silently drop it. gh prints the issue URL → report back #N + URL.
  5. After creation: touch nothing else — no commit, no openspec change.
- **Issue intake (pull)**: the user references an issue number ("làm issue #5", "issue 5", a `github.com/.../issues/5` URL) → run `gh issue view 5 --json number,title,body,labels,comments,url` (fallback: `read issue://5` if `gh issue view` fails) → treat title + body as the work request and route into `skill://openspec-propose` like any propose; the FIRST line of the generated `proposal.md` must be `Issue: #5`. Never close the issue yourself.
- **Post-archive bookkeeping**: when a change whose `proposal.md` first line is `Issue: #N` has just been archived → ask the user "close issue #N with a summary?". If yes → `gh issue close N --reason completed --comment "<1-2 line summary + archived change id>"`, then report the result. If no → leave the issue as is, no comment.
- If an OpenSpec skill file is missing (profile/core-vs-expanded), fall back to the CLI the skill would have driven (`openspec new change`, `openspec instructions <artifact> --change <id> --json`) — never hand-craft files under `openspec/`.
- Messages prefixed `[opsx-autopilot]` are injected user directives: treat them as the user request that authorizes the next workflow step (this satisfies propose's planning boundary, which requires a new user request after artifacts).
- Archive is user-gated, spec-sync is not: when a change is ready, self-review first (verify skill if present, project tests/build, browser tool for UI changes), then ASK the user before archiving. At the archive skill's sync prompt always choose "Sync now (recommended)" and run the inline sync automatically — never ask the user about syncing.
- Never auto-select among multiple active changes; ask.
- Never edit generated files under `.omp/skills/` or `.omp/commands/`; `openspec update` regenerates them.
