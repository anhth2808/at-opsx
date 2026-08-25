/**
 * opsx-autopilot — auto-trigger layer for OpenSpec on OMP.
 *
 * Invariant: OpenSpec core stays 100% untouched. This extension NEVER writes
 * anything under `openspec/`, never blocks tools, and never runs
 * `openspec archive` itself. All OpenSpec mutations flow through the agent
 * executing OpenSpec skills/CLI, driven by directives injected at
 * `session_stop`. The only files it writes are its own `.omp/` assets: the
 * routing rule (self-heal from the packaged rules/) and the default config
 * (via /opsx-init).
 *
 * Runtime deps: Node/Bun builtins only (the omp package import below is
 * type-only and erased at load).
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutopilotConfig {
  enabled: boolean;
  mode: "auto" | "suggest";
  autoApply: true | false;
  verifyCmd: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout?: number },
) => Promise<ExecResult>;

export interface ChangeDetail {
  id: string;
  state: "blocked" | "ready" | "all_done";
  progress: { total: number; complete: number; remaining: number };
  isPlanningComplete: boolean | null;
}

export interface ProbeResult {
  changes: string[];
  detail: ChangeDetail | null;
}

export interface GateResult {
  pass: boolean;
  summary: string;
}

export interface Gates {
  validate: GateResult;
  verify: GateResult | null;
}

export const STATE_CUSTOM_TYPE = "dev.atopsx.opsx-autopilot.v1";
export const HUD_CUSTOM_TYPE = "dev.atopsx.opsx-autopilot.hud";

const DEFAULT_CONFIG: AutopilotConfig = {
  enabled: true,
  mode: "auto",
  autoApply: true,
  verifyCmd: "",
};

const IS_WIN = process.platform === "win32";
const EXEC_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Exec plumbing (Windows-aware: openspec installs as openspec.cmd via npm)
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/** Default exec adapter: plain child_process. Works under Node and Bun. */
async function nodeExec(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout?: number },
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeout ?? EXEC_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err) {
    const e = err as {
      code?: unknown;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (e.killed) {
      return {
        code: null,
        stdout: e.stdout ?? "",
        stderr: `${e.stderr ?? ""} (timed out)`.trim(),
      };
    }
    return {
      code: typeof e.code === "number" ? e.code : null,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(e.message ?? e),
    };
  }
}

type Launcher = { mode: "direct"; command: string } | { mode: "cmd" } | null;
let cachedLauncher: Launcher | undefined;

/**
 * Resolve how to invoke `openspec` on this machine.
 * POSIX: direct. Windows .exe: direct. Windows .cmd/.bat: via cmd.exe
 * (Bun/Node refuse to spawn .cmd shims directly).
 */
function resolveLauncher(): Launcher {
  if (cachedLauncher !== undefined) return cachedLauncher;
  cachedLauncher = resolveLauncherUncached();
  return cachedLauncher;
}

function resolveLauncherUncached(): Launcher {
  if (!IS_WIN) return { mode: "direct", command: "openspec" };
  const pathVar = process.env.PATH ?? "";
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  for (const rawDir of pathVar.split(";")) {
    const dir = rawDir.replace(/^"|"$/g, "");
    if (!dir) continue;
    for (const ext of exts) {
      const p = `${dir}\\openspec${ext}`;
      try {
        if (statSync(p).isFile()) {
          if (ext === ".exe" || ext === ".com") {
            return { mode: "direct", command: p };
          }
          return { mode: "cmd" }; // .cmd / .bat shim
        }
      } catch {
        // not present — keep scanning
      }
    }
  }
  return null;
}

/** Run an `openspec` CLI invocation; null when the launcher is unusable. */
async function runOpenSpec(
  execFn: ExecFn,
  cwd: string,
  args: string[],
): Promise<ExecResult | null> {
  const launcher = resolveLauncher();
  if (!launcher) return null;
  if (launcher.mode === "cmd") {
    const line = ["openspec", ...args]
      .map((tok) => (/[^A-Za-z0-9\-_.,:=@%/\\]/.test(tok) ? `"${tok}"` : tok))
      .join(" ");
    return execFn("cmd.exe", ["/d", "/s", "/c", line], { cwd });
  }
  return execFn(launcher.command, args, { cwd });
}

// ---------------------------------------------------------------------------
// Pure probe + decision logic (exported for standalone testing)
// ---------------------------------------------------------------------------

function parseJsonOut<T>(s: string): T | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    // tolerate banners/noise around the JSON body
  }
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1)) as T;
    } catch {
      // fall through
    }
  }
  return null;
}

export function isOpenspecProject(cwd: string): boolean {
  return (
    existsSync(join(cwd, "openspec", "config.yaml")) ||
    existsSync(join(cwd, "openspec", "config.yml"))
  );
}

/**
 * Probe OpenSpec state for a project. Returns null when not an OpenSpec
 * project or the CLI is unavailable/fails (silent no-op contract).
 */
export async function probe(
  cwd: string,
  execFn: ExecFn = nodeExec,
): Promise<ProbeResult | null> {
  if (!isOpenspecProject(cwd)) return null;
  if (!resolveLauncher()) return null;

  const list = await runOpenSpec(execFn, cwd, ["list", "--json"]);
  if (!list || list.code !== 0) return null;
  const data = parseJsonOut<{ changes?: { name?: unknown }[] }>(list.stdout);
  if (!data || !Array.isArray(data.changes)) return null;
  const changes = data.changes
    .map((c) => (c && typeof c.name === "string" ? c.name : ""))
    .filter(Boolean);
  if (changes.length !== 1) return { changes, detail: null };

  const id = changes[0];
  const apply = await runOpenSpec(execFn, cwd, [
    "instructions",
    "apply",
    "--change",
    id,
    "--json",
  ]);
  if (!apply || apply.code !== 0) return { changes, detail: null };
  const aj = parseJsonOut<{
    state?: unknown;
    progress?: { total?: unknown; complete?: unknown; remaining?: unknown };
  }>(apply.stdout);
  if (!aj || typeof aj.state !== "string") return { changes, detail: null };

  let isPlanningComplete: boolean | null = null;
  const status = await runOpenSpec(execFn, cwd, [
    "status",
    "--change",
    id,
    "--json",
  ]);
  if (status && status.code === 0) {
    const sj = parseJsonOut<{ isPlanningComplete?: unknown }>(status.stdout);
    if (sj && typeof sj.isPlanningComplete === "boolean") {
      isPlanningComplete = sj.isPlanningComplete;
    }
  }

  const p = aj.progress ?? {};
  return {
    changes,
    detail: {
      id,
      state: aj.state as ChangeDetail["state"],
      progress: {
        total: typeof p.total === "number" ? p.total : 0,
        complete: typeof p.complete === "number" ? p.complete : 0,
        remaining: typeof p.remaining === "number" ? p.remaining : 0,
      },
      isPlanningComplete,
    },
  };
}

function gateSummary(r: ExecResult | null): string {
  if (!r) return "not-run";
  const head = (r.stderr || r.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ");
  const code = r.code === null ? "killed" : `exit ${r.code}`;
  return head ? `${code}: ${head}` : code;
}

/** Gates before archive: `openspec validate <id>` and (optionally) verifyCmd. */
export async function runGates(
  cwd: string,
  id: string,
  verifyCmd: string,
  execFn: ExecFn = nodeExec,
): Promise<Gates> {
  const v = await runOpenSpec(execFn, cwd, ["validate", id]);
  const validate: GateResult = {
    pass: !!v && v.code === 0,
    summary: !v ? "not-run" : v.code === 0 ? "PASS (exit 0)" : gateSummary(v),
  };
  let verify: GateResult | null = null;
  const cmd = (verifyCmd ?? "").trim();
  if (cmd) {
    const r = IS_WIN
      ? await execFn("cmd.exe", ["/d", "/s", "/c", cmd], { cwd })
      : await execFn("/bin/sh", ["-c", cmd], { cwd });
    verify = {
      pass: !!r && r.code === 0,
      summary: !r ? "not-run" : r.code === 0 ? "PASS (exit 0)" : gateSummary(r),
    };
  }
  return { validate, verify };
}

export function gatesPassed(g: Gates): boolean {
  return g.validate.pass && (!g.verify || g.verify.pass);
}

export function chooserKey(changes: string[]): string {
  return `chooser:${[...changes].sort().join(",")}`;
}

/**
 * Pure decision: what should the autopilot do for this probe result?
 * "gates" means: evaluate gates, then archive/fix per their outcome.
 */
export function nextAction(
  p: ProbeResult,
  config: AutopilotConfig,
  fired: Set<string>,
): "none" | "apply" | "chooser" | "gates" {
  if (p.changes.length === 0) return "none";
  if (p.changes.length > 1) {
    return fired.has(chooserKey(p.changes)) ? "none" : "chooser";
  }
  const d = p.detail;
  if (!d) return "none";
  if (d.state === "all_done") {
    // Re-evaluate gates on every stop (cheap); only the ARCHIVE directive and
    // the FIX directive are fired at most once per change.
    return fired.has(`${d.id}:archive`) ? "none" : "gates";
  }
  // "ready" already encodes: apply unblocked (applyRequires satisfied, tasks
  // file non-empty) — do NOT additionally require isPlanningComplete: a
  // conditionally-omitted design.md leaves that flag false forever while
  // OpenSpec itself reports the change as applicable.
  if (
    d.state === "ready" &&
    d.progress.complete === 0 &&
    config.autoApply === true &&
    !fired.has(`${d.id}:apply`)
  ) {
    return "apply";
  }
  return "none";
}

// ---------------------------------------------------------------------------
// Directive templates (exact contract — agents and tests depend on these)
// ---------------------------------------------------------------------------

export function applyDirective(id: string, total: number): string {
  return [
    `[opsx-autopilot] Planning complete for "${id}" (all planning artifacts done, 0/${total} tasks checked).`,
    `AUTOPILOT DIRECTIVE (this message is the user authorization to start implementation):`,
    `read skill://openspec-apply-change and follow it end-to-end for this change now.`,
    `If that skill is not available, fall back to: openspec instructions apply --change ${id} --json and implement per its output.`,
  ].join("\n");
}

export function archiveDirective(id: string, total: number, g: Gates): string {
  const verifyPart = g.verify ? ", verifyCmd=PASS" : "";
  return [
    `[opsx-autopilot] "${id}": all tasks checked ([x] ${total}/${total}); gates: validate=PASS${verifyPart}.`,
    `AUTOPILOT DIRECTIVE:`,
    `1) Self-review first: if skill openspec-verify-change is available, read and follow it; otherwise review the implementation yourself against proposal.md, specs/, and tasks.md. For UI-facing changes, verify with the browser tool.`,
    `2) Present a short self-review summary (tasks, gates, findings), then ASK THE USER: 'Archive "${id}" now? Delta specs will be synced into openspec/specs/ automatically.' Do NOT archive before the user confirms.`,
    `3) On user confirmation: read skill://openspec-archive-change and follow it end-to-end. The spec-sync step is NOT a question — always choose 'Sync now (recommended)' and run the inline sync automatically.`,
    `4) Report the archived folder path and which spec capabilities were synced.`,
    `If the user declines: stop and leave the change active (no archive, no sync).`,
    `If self-review finds gaps: fix them, re-run gates once, then ask the user again. If still failing, stop and report why.`,
  ].join("\n");
}

export function fixDirective(id: string, g: Gates): string {
  const verifyPart = g.verify ? `, verifyCmd=${g.verify.summary}` : "";
  return [
    `[opsx-autopilot] "${id}": all tasks checked but gates FAILED: validate=${g.validate.summary}${verifyPart}.`,
    `Fix the failures, then the autopilot will re-evaluate. Do not archive yet.`,
  ].join("\n");
}

export function chooserDirective(ids: string[]): string {
  return `[opsx-autopilot] Multiple active changes ready: ${ids.join(", ")}. Never auto-select — ask the user which one to proceed with.`;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function loadConfig(cwd: string): AutopilotConfig {
  try {
    const parsed = JSON.parse(
      readFileSync(join(cwd, ".omp", "opsx-autopilot.json"), "utf8"),
    ) as Partial<AutopilotConfig>;
    // "confirm" is a legacy alias of "auto": the archive confirmation now
    // happens in-chat via the directive (works headless and interactive),
    // not via a blocking dialog.
    const mode =
      parsed.mode === "auto" || parsed.mode === "confirm"
        ? "auto"
        : "suggest"; // "suggest" and unknown → safest (nudge-only)
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
      mode,
      autoApply: typeof parsed.autoApply === "boolean" ? parsed.autoApply : true,
      verifyCmd: typeof parsed.verifyCmd === "string" ? parsed.verifyCmd : "",
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function opsxAutopilotExtension(pi: ExtensionAPI): void {
  let fired = new Set<string>();
  let hudShown = false;

  const execFn: ExecFn = async (cmd, args, opts) => {
    const r = await pi.exec(cmd, args, { cwd: opts.cwd });
    return {
      code: r.killed ? null : r.code,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  };

  function persistFired(): void {
    try {
      pi.appendEntry(STATE_CUSTOM_TYPE, { fired: [...fired] });
    } catch {
      // persistence is best-effort; the in-memory set still guards this session
    }
  }

  function markFired(key: string): void {
    fired.add(key);
    persistFired();
  }

  function restoreFired(ctx: { sessionManager: { getBranch: () => unknown[] } }): void {
    try {
      let latest: { fired?: unknown } | null = null;
      for (const entry of ctx.sessionManager.getBranch()) {
        const e = entry as { type?: string; customType?: string; data?: { fired?: unknown } };
        if (e && e.type === "custom" && e.customType === STATE_CUSTOM_TYPE) {
          latest = e.data ?? null;
        }
      }
      if (latest && Array.isArray(latest.fired)) {
        fired = new Set(latest.fired.map(String));
      }
    } catch {
      // unreadable history → start fresh (loop safety still bounded by omp's 8-cap)
    }
  }

  function guarded(cwd: string): boolean {
    return isOpenspecProject(cwd) && !!resolveLauncher();
  }

  function hudText(p: ProbeResult, cfg: AutopilotConfig): string {
    if (p.changes.length === 0) {
      return `[opsx-autopilot] OpenSpec active, no active changes. Route non-trivial build/fix/plan requests through skill://openspec-propose (see rule opsx-autopilot). mode=${cfg.mode}`;
    }
    if (!p.detail) {
      return `[opsx-autopilot] Active change(s): ${p.changes.join(", ")}. mode=${cfg.mode}. See rule opsx-autopilot for routing.`;
    }
    const d = p.detail;
    return `[opsx-autopilot] Active change: ${d.id} — ${d.progress.complete}/${d.progress.total} tasks done, state=${d.state}, planningComplete=${d.isPlanningComplete}. mode=${cfg.mode}. See rule opsx-autopilot for routing.`;
  }

  function suggestNudge(
    ctx: { ui: { notify: (m: string, l?: string) => void } },
    id: string,
  ): void {
    try {
      ctx.ui.notify(
        `[opsx-autopilot] "${id}" looks ready to archive (all tasks done, gates pass). Say "archive ${id}" when ready — not archiving automatically (mode=suggest).`,
        "info",
      );
    } catch {
      // headless no-op
    }
  }

  /**
   * Plugin `rules/` capability folders are not registered by omp's plugin
   * discovery on current builds, so the extension ensures the rule itself:
   * on session start in an OpenSpec project, copy the packaged
   * rules/opsx-autopilot.md into <cwd>/.omp/rules/ when missing. The rule
   * takes effect from the NEXT omp start in that project. Vendored installs
   * skip this (init.mjs --vendor already placed the rule; no package dir).
   */
  function ensureProjectRule(cwd: string): void {
    try {
      if (!isOpenspecProject(cwd)) return;
      const dst = join(cwd, ".omp", "rules", "opsx-autopilot.md");
      if (existsSync(dst)) return;
      // Bun exposes import.meta.dir at runtime; TS lib types lack it.
      const meta = import.meta as { dir?: string };
      if (!meta.dir) return;
      const src = join(meta.dir, "..", "rules", "opsx-autopilot.md");
      if (!existsSync(src)) return;
      mkdirSync(join(cwd, ".omp", "rules"), { recursive: true });
      writeFileSync(dst, readFileSync(src, "utf8"), "utf8");
    } catch {
      // best-effort — the rule also ships via init.mjs for scripted installs
    }
  }

  for (const ev of ["session_start", "session_branch", "session_tree"] as const) {
    pi.on(ev, async (_event: unknown, ctx: { cwd: string; sessionManager: { getBranch: () => unknown[] } }) => {
      restoreFired(ctx);
      ensureProjectRule(ctx.cwd);
    });
  }

  // One-line HUD on the first turn of the session.
  pi.on("before_agent_start", async (_event: unknown, ctx: { cwd: string }) => {
    try {
      if (hudShown) return;
      hudShown = true;
      if (!guarded(ctx.cwd)) return;
      const cfg = loadConfig(ctx.cwd);
      if (!cfg.enabled) return;
      const p = await probe(ctx.cwd, execFn);
      if (!p) return;
      const text = hudText(p, cfg);
      return {
        message: {
          customType: HUD_CUSTOM_TYPE,
          content: text,
          display: text,
          details: { source: "opsx-autopilot" },
        },
      };
    } catch {
      return;
    }
  });

  // The single trigger point: no tool interception, no input interception.
  pi.on("session_stop", async (
    _event: unknown,
    ctx: { cwd: string; ui: { notify: (m: string, l?: string) => void } },
  ) => {
    try {
      if (!guarded(ctx.cwd)) return;
      const cfg = loadConfig(ctx.cwd);
      if (!cfg.enabled) return;

      const p = await probe(ctx.cwd, execFn);
      if (!p) return;
      const action = nextAction(p, cfg, fired);

      if (action === "chooser") {
        markFired(chooserKey(p.changes));
        return { continue: true, additionalContext: chooserDirective(p.changes) };
      }

      if (action === "apply") {
        const d = p.detail!;
        markFired(`${d.id}:apply`);
        return { continue: true, additionalContext: applyDirective(d.id, d.progress.total) };
      }

      if (action === "gates") {
        const d = p.detail!;
        const g = await runGates(ctx.cwd, d.id, cfg.verifyCmd, execFn);

        if (gatesPassed(g)) {
          if (cfg.mode === "suggest") {
            suggestNudge(ctx, d.id);
            return;
          }
          // mode=auto: the directive has the agent ASK THE USER in-chat
          // before archiving; the spec sync inside the archive stays automatic.
          markFired(`${d.id}:archive`);
          return {
            continue: true,
            additionalContext: archiveDirective(d.id, d.progress.total, g),
          };
        }

        if (!fired.has(`${d.id}:gates-fix`)) {
          markFired(`${d.id}:gates-fix`);
          return { continue: true, additionalContext: fixDirective(d.id, g) };
        }
        return; // already told once — no nag loop
      }
      return;
    } catch {
      return;
    }
  });

  // Bootstrap aid: /opsx-init — openspec init (when missing) + default config.
  // Makes `omp install opsx-autopilot@at-opsx --scope=project` the ONLY step
  // needed besides this command; init.mjs remains for scripted use.
  pi.registerCommand("opsx-init", {
    description: "opsx-autopilot: bootstrap OpenSpec (openspec init) and write the default config",
    handler: async (
      _args: unknown,
      ctx: { cwd: string; ui: { notify: (m: string, l?: string) => void } },
    ) => {
      try {
        if (!resolveLauncher()) {
          ctx.ui.notify(
            "opsx-init: `openspec` is not on PATH. Install it first: npm install -g @openspec/cli",
            "error",
          );
          return;
        }
        if (!isOpenspecProject(ctx.cwd)) {
          const r = await runOpenSpec(
            execFn,
            ctx.cwd,
            ["init", "--tools", "oh-my-pi", "--no-copilot-cloud"],
          );
          if (!r || r.code !== 0) {
            ctx.ui.notify(
              `opsx-init: openspec init failed${r ? ` (exit ${r.code})` : ""}. Run manually:\n  openspec init --tools oh-my-pi --no-copilot-cloud`,
              "error",
            );
            return;
          }
          ctx.ui.notify("opsx-init: openspec initialized (skills + commands in .omp/)", "info");
        } else {
          ctx.ui.notify("opsx-init: openspec/ already present — skipped init", "info");
        }
        const cfgPath = join(ctx.cwd, ".omp", "opsx-autopilot.json");
        if (!existsSync(cfgPath)) {
          mkdirSync(join(ctx.cwd, ".omp"), { recursive: true });
          writeFileSync(cfgPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
          ctx.ui.notify(`opsx-init: wrote default config ${cfgPath} (tune verifyCmd/mode there)`, "info");
        } else {
          ctx.ui.notify(`opsx-init: config exists — kept (${cfgPath})`, "info");
        }
        ensureProjectRule(ctx.cwd);
        ctx.ui.notify("opsx-init: rule ensured at .omp/rules/opsx-autopilot.md (active from next omp start)", "info");
        ctx.ui.notify(
          "opsx-init: done. Restart omp in this project, then describe work in a normal prompt.",
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`opsx-init: ${(err as Error).message}`, "error");
      }
    },
  });

  // Debug aid: /opsx-auto — probe and show a compact summary.
  pi.registerCommand("opsx-auto", {
    description: "opsx-autopilot: probe OpenSpec state and show a summary",
    handler: async (
      _args: unknown,
      ctx: { cwd: string; ui: { notify: (m: string, l?: string) => void } },
    ) => {
      try {
        if (!guarded(ctx.cwd)) {
          ctx.ui.notify("opsx-autopilot: not an active OpenSpec project (or openspec not on PATH) — no-op", "info");
          return;
        }
        const cfg = loadConfig(ctx.cwd);
        const p = await probe(ctx.cwd, execFn);
        if (!p) {
          ctx.ui.notify("opsx-autopilot: probe failed (openspec CLI error)", "info");
          return;
        }
        let gates = "";
        if (p.detail && p.detail.state === "all_done") {
          const g = await runGates(ctx.cwd, p.detail.id, cfg.verifyCmd, execFn);
          gates = ` gates={validate:${g.validate.pass ? "PASS" : "FAIL"}, verify:${!g.verify ? "n/a" : g.verify.pass ? "PASS" : "FAIL"}}`;
        }
        const firedKeys = [...fired].join("|") || "none";
        ctx.ui.notify(
          `opsx-autopilot: {enabled:${cfg.enabled}, mode:${cfg.mode}, autoApply:${cfg.autoApply}, verifyCmd:${JSON.stringify(cfg.verifyCmd)}} changes=[${p.changes.join(", ")}]${p.detail ? ` detail={id:${p.detail.id}, state:${p.detail.state}, progress:${p.detail.progress.complete}/${p.detail.progress.total}, planningComplete:${p.detail.isPlanningComplete}}` : ""}${gates} fired=[${firedKeys}]`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`opsx-autopilot: ${(err as Error).message}`, "error");
      }
    },
  });
}
