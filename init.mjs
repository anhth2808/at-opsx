#!/usr/bin/env node
/**
 * opsx-autopilot project initializer — one command per project.
 *
 *   node init.mjs <target-dir> [--force] [--vendor]
 *
 * Node >= 20, no dependencies.
 *
 * Default (plugin mode): bootstraps `openspec init` when the target has no
 * openspec/ yet, installs the project-scoped rule + tunable config, and expects
 * the extension itself to be loaded as an omp plugin (`omp install <this-repo>`
 * or via marketplace) — omp's plugin discovery handles the factory module.
 *
 * --vendor: additionally copies src/main.ts into <target>/.omp/extensions/ and
 * wires .omp/config.yml — for omp builds without plugin support. Do NOT use
 * both plugin install and --vendor in the same project (double registration).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
const EXTENSION_ENTRY = "./.omp/extensions/opsx-autopilot.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const SRC = {
  extension: join(scriptDir, "src", "main.ts"),
  rule: join(scriptDir, "rules", "opsx-autopilot.md"),
  config: join(scriptDir, "config", "opsx-autopilot.json"),
};

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const force = args.includes("--force");
const vendor = args.includes("--vendor");
const targetArg = args.find((a) => a !== "--force" && a !== "--vendor");
if (!targetArg) {
  console.error("Usage: node init.mjs <target-dir> [--force] [--vendor]");
  process.exit(1);
}
const target = resolve(targetArg);
if (!existsSync(target) || !statSync(target).isDirectory()) {
  console.error(`opsx-autopilot: target directory not found: ${target}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(step, msg) {
  console.log(`[opsx-autopilot] ${step}: ${msg}`);
}

function resolveOpenspecLauncher() {
  if (!IS_WIN) return { mode: "direct", command: "openspec" };
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  for (const rawDir of (process.env.PATH ?? "").split(";")) {
    const dir = rawDir.replace(/^"|"$/g, "");
    if (!dir) continue;
    for (const ext of exts) {
      const p = `${dir}\\openspec${ext}`;
      try {
        if (statSync(p).isFile()) {
          if (ext === ".exe" || ext === ".com") return { mode: "direct", command: p };
          return { mode: "cmd" };
        }
      } catch {
        // keep scanning
      }
    }
  }
  return null;
}

function runOpenspecInherit(cliArgs, cwd) {
  const launcher = resolveOpenspecLauncher();
  if (!launcher) return { failed: "openspec-not-on-path" };
  if (launcher.mode === "cmd") {
    const line = ["openspec", ...cliArgs].join(" ");
    return { status: spawnSync("cmd.exe", ["/d", "/s", "/c", line], { cwd, stdio: "inherit" }).status };
  }
  return { status: spawnSync(launcher.command, cliArgs, { cwd, stdio: "inherit" }).status };
}

function copyFile(src, dst, { overwrite }) {
  if (existsSync(dst) && !overwrite) return "skipped (exists)";
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  return "written";
}

/** --vendor only: merge the extension entry into .omp/config.yml. */
function ensureConfigYml(ompDir) {
  const cfgPath = join(ompDir, "config.yml");
  if (!existsSync(cfgPath)) {
    writeFileSync(cfgPath, `extensions:\n  - ${EXTENSION_ENTRY}\n`, "utf8");
    return "created with extensions entry";
  }
  const text = readFileSync(cfgPath, "utf8");
  if (text.includes(EXTENSION_ENTRY)) return "entry already present";

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(/^(\s*)extensions:\s*\[(.*)\]\s*(#.*)?$/);
    if (inline) {
      const [, indent, body] = inline;
      const items = body.split(",").map((s) => s.trim()).filter(Boolean);
      items.push(EXTENSION_ENTRY);
      lines[i] = `${indent}extensions: [${items.join(", ")}]`;
      writeFileSync(cfgPath, lines.join("\n"), "utf8");
      return "added to existing inline extensions list";
    }
    const block = lines[i].match(/^(\s*)extensions:\s*(#.*)?$/);
    if (block) {
      const keyIndent = block[1];
      let itemIndent = `${keyIndent}  `;
      for (let j = i + 1; j < lines.length; j++) {
        const m = lines[j].match(/^(\s*)-\s/);
        if (m) {
          itemIndent = m[1];
          break;
        }
        if (!/^\s*$/.test(lines[j]) && !/^\s*#/.test(lines[j])) break;
      }
      lines.splice(i + 1, 0, `${itemIndent}- ${EXTENSION_ENTRY}`);
      writeFileSync(cfgPath, lines.join("\n"), "utf8");
      return "added under existing extensions key";
    }
  }

  writeFileSync(cfgPath, `${text.replace(/\s*$/, "")}\n\nextensions:\n  - ${EXTENSION_ENTRY}\n`, "utf8");
  return "appended extensions block";
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

const hasOpenspecProject =
  existsSync(join(target, "openspec", "config.yaml")) ||
  existsSync(join(target, "openspec", "config.yml"));

if (!hasOpenspecProject) {
  if (!resolveOpenspecLauncher()) {
    console.error(
      "opsx-autopilot: `openspec` is not on PATH and the target has no openspec/ directory.\n" +
        "Install OpenSpec first:  npm install -g @openspec/cli  (or see https://openspec.io)",
    );
    process.exit(1);
  }
  log("init", `running: openspec init --tools oh-my-pi --no-copilot-cloud (in ${target})`);
  const r = runOpenspecInherit(["init", "--tools", "oh-my-pi", "--no-copilot-cloud"], target);
  if (r.failed || typeof r.status !== "number" || r.status !== 0) {
    console.error(
      "opsx-autopilot: `openspec init` failed" +
        (typeof r.status === "number" ? ` (exit ${r.status})` : "") +
        ".\nRun it manually, then re-run this initializer:\n" +
        "  cd <target> && openspec init --tools oh-my-pi --no-copilot-cloud",
    );
    process.exit(1);
  }
  if (
    !existsSync(join(target, "openspec", "config.yaml")) &&
    !existsSync(join(target, "openspec", "config.yml"))
  ) {
    console.error("opsx-autopilot: `openspec init` reported success but no openspec/config.yaml was created. Aborting.");
    process.exit(1);
  }
  log("init", "openspec initialized");
} else {
  log("init", "openspec/ already present — skipping `openspec init` (idempotent)");
}

const ompDir = join(target, ".omp");

log("rule", copyFile(SRC.rule, join(ompDir, "rules", "opsx-autopilot.md"), { overwrite: true }));
log("config", copyFile(SRC.config, join(ompDir, "opsx-autopilot.json"), { overwrite: force }));

if (vendor) {
  log("extension", copyFile(SRC.extension, join(ompDir, "extensions", "opsx-autopilot.ts"), { overwrite: true }));
  log("config.yml", ensureConfigYml(ompDir));
} else {
  console.log(
    "[opsx-autopilot] extension: not copied (plugin mode) — load it with ONE of:\n" +
      `  omp install ${scriptDir}                 # link this checkout (user scope)\n` +
      `  omp plugin marketplace add <git-url>     # then: omp install opsx-autopilot@at-opsx\n` +
      "  omp --extension " + scriptDir + "/src/main.ts   # one-shot\n" +
      "Or re-run with --vendor to copy the extension into the project instead.",
  );
}

if (!existsSync(join(ompDir, "skills", "openspec-verify-change", "SKILL.md"))) {
  console.log(
    "[opsx-autopilot] hint: skill://openspec-verify-change is not installed (core profile).\n" +
      "  Optional: `openspec config profile` (pick a profile with verify) + `openspec update` enables it.\n" +
      "  The autopilot works without it — its archive directive has a built-in self-review fallback.",
  );
}

console.log(
  "\n[opsx-autopilot] done. Restart omp in this project, then just describe work in a normal prompt\n" +
    "(e.g. \"thêm tính năng X: node index.js greet <name> in ra Hello, <name>\") — the routing rule +\n" +
    "session_stop chaining handle propose → apply → self-review → ask-to-archive (sync automatic).",
);
