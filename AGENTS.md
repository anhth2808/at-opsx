# Repository Guidelines

## Project Overview

`opsx-autopilot` (repo `at-opsx`) is a git-distributed **omp extension package** (v0.4.0) that adds an auto-pilot layer over [OpenSpec](https://openspec.io) on the OMP coding harness. A normal prompt routes through OpenSpec's workflow without `/opsx-*` slash commands: intent routing (rule) → propose → apply → self-review → **user-gated archive with automatic spec-delta sync**, chained via `session_stop` continuation directives. Defer-intent prompts go to a GitHub-issue backlog loop instead (defer → `gh issue create`; pull → propose; post-archive → close) — agent-driven via `gh`, no extra commands/config.

**Core invariant**: OpenSpec stays 100% untouched. The extension never writes under `openspec/`, never blocks tools, never runs `openspec archive` — all OpenSpec mutations flow through the agent executing OpenSpec skills/CLI. The only files the extension writes are its own `.omp/` assets (rule self-heal, default config). Nothing lives under generated `.omp/skills/` or `.omp/commands/`, so `openspec update` regenerates them freely.

## Architecture & Data Flow

Two layers in the single source file `src/main.ts`:

1. **Pure, exported decision core** (all shell I/O behind an injectable `ExecFn` — standalone-testable without omp):
   `probe(cwd, execFn?)` → runs `openspec list --json`, `instructions apply --json`, `status --json` → `ProbeResult`
   → `nextAction(p, config, firedSet)` → `"none" | "apply" | "chooser" | "gates"` → directive builders (`applyDirective`, `archiveDirective`, `fixDirective`, `chooserDirective`).
2. **Thin impure factory** (`export default (pi: ExtensionAPI)`) wiring `pi.exec`, fired-key persistence, and the omp event surface.

Event → action state machine:

| Event | Behavior |
|---|---|
| `session_start`/`session_branch`/`session_tree` | `restoreFired` (from `ctx.sessionManager.getBranch()` custom entries) + `ensureProjectRule` (self-heal) |
| `before_agent_start` | one-shot HUD message (`hudShown` latch) |
| `session_stop` (**the single trigger point** — no tool/input interception) | guard (OpenSpec project + launcher + `enabled`) → probe → nextAction → `{continue: true, additionalContext: <directive>}` |

`nextAction` conditions: `apply` = single change, `state:"ready"`, `progress.complete===0`, `autoApply` (deliberately does **not** require `isPlanningComplete` — a conditionally-omitted `design.md` leaves it false forever); `gates` = `state:"all_done"` → `openspec validate <id>` + optional `verifyCmd`, PASS → archive directive (asks user, syncs automatically), FAIL → fix directive once; `chooser` = multiple changes → ask, never auto-select.

**Loop safety**: fired keys `<id>:apply`, `<id>:archive`, `<id>:gates-fix`, `chooser:<sorted-ids>` — each directive fires at most once per change; persisted via `pi.appendEntry("dev.atopsx.opsx-autopilot.v1", {fired})`, best-effort; omp also caps continuations at 8.

**Rule self-heal (versioned)**: omp plugin builds don't register packaged `rules/` folders, so `ensureProjectRule` (module-scope, exported) copies `rules/opsx-autopilot.md` → `<project>/.omp/rules/` on session events; an existing rule without a marker or with an older `opsx-autopilot-rule: vN` marker is backed up to `opsx-autopilot.md.bak` and replaced (effective next omp start; marker ≥ `RULE_VERSION` is left untouched). Single source: repo-root `rules/`.

## Key Directories

| Path | Purpose |
|---|---|
| `src/main.ts` | Sole extension source (~740 lines): types → exec plumbing → pure logic → directives → config → factory + commands |
| `rules/opsx-autopilot.md` | Routing rule (`alwaysApply: true`): intent routing, `[opsx-autopilot]` directives = user authorization, archive user-gated + sync automatic |
| `config/opsx-autopilot.json` | Default project config template `{enabled, mode:"auto", autoApply, verifyCmd:""}`; runtime path is `<project>/.omp/opsx-autopilot.json` |
| `init.mjs` | Scripted/CI initializer: `node init.mjs <target> [--force] [--vendor]` — openspec bootstrap + config copy; `--vendor` also copies extension+rule and merges `.omp/config.yml` |
| `.claude-plugin/marketplace.json` | omp marketplace catalog (`at-opsx` → plugin `opsx-autopilot`, `source: "./"`) |
| `sandbox/` | Gitignored disposable e2e fixtures (`demo-app` = live OpenSpec project with archived-change proof; `fresh-app` = pristine init reference). Never shipped. |

## Development Commands

No package scripts, no deps, no build step. Verification is behavioral:

```bash
# syntax gate (transpile check; leaves gitignored NUL artifact on Windows)
bun build ./src/main.ts --target=bun --outfile=NUL

# pure-logic checks (bun imports main.ts standalone — omp import is type-only)
bun -e "const m = await import('./src/main.ts'); console.log(m.nextAction(
  {changes:['x'], detail:{id:'x', state:'ready', progress:{total:2,complete:0,remaining:2}, isPlanningComplete:null}},
  {enabled:true, mode:'auto', autoApply:true, verifyCmd:''}, new Set()))"   # → "apply"

# live probe against the sandbox fixture (from sandbox/demo-app)
bun -e "const m = await import('../../src/main.ts'); console.log(await m.probe(process.cwd()))"

# load smoke (silent ~2s dispatch = loaded; falls through to model = not loaded)
omp -p '/opsx-auto'

# installer idempotency (run twice; second run must skip)
node init.mjs <dir> [--vendor]

# e2e proof (from sandbox/demo-app): plain prompt drives propose→apply→gates→archive+sync;
# judged by on-disk state: openspec/changes/archive/<date>-<id>/, synced openspec/specs/, empty `openspec list`, npm test exit 0
omp -p "Add a greet feature: node index.js greet <name> prints Hello, <name>."
```

Release flow: bump `package.json` **and** `.claude-plugin/marketplace.json` in lockstep + git tag `vX.Y.Z`, push, install pinned (`omp install github:anhth2808/at-opsx#vX.Y.Z`). Update the installed plugin the same way.

## Code Conventions & Common Patterns

- **Silent no-op contract**: every autonomous path degrades quietly — probe returns null/degraded, event handlers wrap everything in `try/catch → return`. Only the `/opsx-*` commands are loud (`ctx.ui.notify(..., "error")`).
- **Type-only omp import** (`import type { ExtensionAPI }`) + node/bun builtins only; handler `ctx` params use hand-written structural types. Never add a runtime dependency on `@oh-my-pi/pi-coding-agent`.
- **Directive strings are an exact contract** (agents and tests depend on them) — change them only with full e2e re-verification.
- Defensive JSON: `parseJsonOut` brace-slice fallback + `typeof` narrowing of every field; no unchecked casts.
- Config normalization at load: `mode` ∈ `{"auto","suggest"}` (legacy `"confirm"` → `"auto"`; unknown → `"suggest"` — safest); per-field fallbacks; any error → defaults.
- **Windows-aware process spawning**: `openspec` installs as `openspec.cmd`; `resolveLauncher` scans PATH+PATHEXT (`.exe`/`.com` direct, `.cmd`/`.bat` via `cmd.exe /d /s /c`), memoized module-singleton. `verifyCmd` routes through `cmd.exe` on win32, `/bin/sh` elsewhere. Token quoting lives in `src/main.ts` `runOpenSpec` — `init.mjs` duplicates the launcher scan but **lacks quoting**: port it before passing args with spaces.
- Small duplication beats premature helpers (the Windows launcher algorithm is intentionally duplicated in `init.mjs` so the installer runs standalone).
- Repo rules enforced by the environment: no tiny one-expression functions (unless exported/test-seam/3+ call sites), top-level `import type` only, `Set` only for dynamic membership.

## Important Files

- `src/main.ts` — everything runtime: probes `:217`, `nextAction` `:328`, directives `:363-396`, `loadConfig` `:402`, factory `:429`, `session_stop` `:558`, commands `/opsx-init` `:615`, `/opsx-update` `:668` (runs `openspec update --force`), `/opsx-auto` `:705`.
- `package.json` — plugin id source of truth (`opsx-autopilot`) via `omp.extensions: ["./src/main.ts"]`; no deps/scripts.
- `rules/opsx-autopilot.md` — the always-applied routing contract (intent routing incl. the GitHub-issue defer path, issue create/pull/close procedures, archive gating).
- `init.mjs` — offline bootstrap complement; plugin mode copies only config (rule/extension come from the plugin), `--vendor` copies all three + `config.yml` merge.
- `README.md` — install flows, config table, caveats.

## Runtime/Tooling Preferences

- **Runtime**: omp loads `src/main.ts` with Bun; standalone checks must use `bun` (plain `node` cannot import the `.ts`). `init.mjs` targets Node ≥ 20. Requires `openspec` CLI on PATH (verified against 1.9.0 and 1.11.0).
- **Package manager**: none (zero deps). Distribution is git: git-direct `omp install github:anhth2808/at-opsx#tag` (GitHub tarball API — no `file://`), marketplace (`omp plugin marketplace add anhth2808/at-opsx` + `--scope=project`), or `--vendor`.
- **Do not mix** git-direct user-scope with `--scope=project`/`--vendor` in one project — double registration fires directives twice. Project-scope installs point into shared `~/.omp/plugins/cache/`; uninstalling the user-scope copy dangles them (fix: reinstall `--scope=project --force`).
- Windows: local-path `omp install ./repo` needs Developer Mode (symlink). Gitignore covers `NUL` (bun build artifact), `.omp/` (repo-root session registry), `sandbox/`.

## Testing & QA

No formal suite — proof is behavioral, bottom-up:

1. **Pure logic**: equality of `bun -e` returns (decision table, directive strings, config normalization).
2. **Loads**: `omp -p '/opsx-auto'` silent ~2s dispatch (in a non-OpenSpec dir it prints the no-op notice — doubling as the guard check).
3. **Works**: on-disk OpenSpec state after a plain-prompt omp run in `sandbox/demo-app` (archive dir, synced `openspec/specs/`, empty `openspec list`, `verifyCmd` green).
4. **Doesn't overreach**: no `[opsx-autopilot]` output in non-OpenSpec projects; multi-change → chooser asks; each directive fires once.

When adding tests, target the exported pure seam (`probe`/`nextAction`/`runGates`/`loadConfig`/directive builders with a fake `ExecFn`). Changes to `session_stop` logic or directive text require an e2e rerun in the sandbox.
