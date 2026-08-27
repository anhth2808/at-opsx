# opsx-autopilot

Auto-pilot layer for [OpenSpec](https://openspec.io) on the **OMP** (Oh My Pi) coding harness, packaged as a standard omp extension package (git-distributed). You describe work in a normal prompt; the pack routes it through the OpenSpec workflow and chains the phases — no `/opsx-*` slash commands.

```
normal prompt ("thêm tính năng X…")
   │  project rule .omp/rules/opsx-autopilot.md (always applied)
   ▼
openspec-propose ──stop──► session_stop: planning done, 0/N tasks
   │                          │ APPLY directive (continue)
   ▼                          ▼
openspec/changes/<id>/ artifacts ──► openspec-apply-change (implements, checks tasks)
   │                              stop
   │  state=all_done ──► gates: openspec validate <id>  +  verifyCmd (optional)
   │        │PASS                    │FAIL (once per change)
   │        ▼                        ▼
   │  ARCHIVE directive:        FIX directive: fix, then re-evaluate
   │  self-review ──► ASK USER "archive now?" ──► openspec-archive-change
   ▼                                (delta-spec sync runs automatically)
openspec/changes/archive/YYYY-MM-DD-<id>/  +  openspec/specs/<capability>/spec.md
```

**Invariant:** OpenSpec core stays 100% untouched. The extension never writes anything under `openspec/`, never blocks tools, and never runs `openspec archive` itself — every OpenSpec mutation flows through the agent executing OpenSpec skills/CLI. The only files it writes are its own `.omp/` assets (the routing rule via self-heal, the default config via `/opsx-init`). Nothing lives under the generated `.omp/skills/` or `.omp/commands/` trees, so `openspec update` can regenerate them freely.

## Repo layout (omp extension package)

```
package.json                    ← omp.extensions manifest → ./src/main.ts
src/main.ts                     ← extension factory (ExtensionAPI) + /opsx-init + /opsx-auto
rules/opsx-autopilot.md         ← routing rule (single source — self-healed into each project's .omp/rules/)
config/opsx-autopilot.json      ← default project config (copied by init.mjs; /opsx-init writes it inline)
init.mjs                        ← scripted/CI initializer (openspec init + config; --vendor fallback)
.claude-plugin/marketplace.json ← marketplace catalog
```

## Install (kiểu git)

Yêu cầu: Node ≥ 20, `openspec` (1.9.0 đã kiểm chứng) trên PATH.

**1) Load extension (chọn MỘT cách):**

```bash
# GIT-DIRECT (gọn nhất cho dùng cá nhân — một lệnh cho mọi project):
omp install github:anhth2808/at-opsx#v0.3.0        # tag phải tồn tại; bump tag để update
# hoặc https git URL:
omp install https://github.com/anhth2808/at-opsx.git
# hoặc từ checkout local (Windows cần Developer Mode vì dùng symlink):
git clone https://github.com/anhth2808/at-opsx && omp install ./at-opsx
# hoặc one-shot:
omp --extension ./src/main.ts

# PER-PROJECT (muốn đăng ký theo từng project; marketplace hỗ trợ --scope=project):
omp plugin marketplace add anhth2808/at-opsx        # một lần duy nhất trên máy
cd <project> && omp install opsx-autopilot@at-opsx --scope=project
```

Ghi chú:
- **Không trộn lẫn** git-direct user-scope với `--scope=project` trong cùng project (extension load 2 lần → directive bắn kép).
- Git-direct resolve qua GitHub tarball API nên **không** nhận `file://` local; plugin id luôn là `opsx-autopilot` (theo `package.json`), bất kể tên repo.
- Project-scope: registry nằm ở `<project>/.omp/plugins/installed_plugins.json`, chỉ load khi omp chạy đúng cwd đó (`omp plugin list` ở thư mục khác sẽ trống). **Caveat**: bản ghi project trỏ vào cache dùng chung `~/.omp/plugins/cache/` — gỡ bản user-scope cùng plugin sẽ dọn sạch cache này làm project install treo; khắc phục: `omp install opsx-autopilot@at-opsx --scope=project --force`. Cài bản project SAU CÙNG.
- Phiên bản: bump `package.json` + `.claude-plugin/marketplace.json` + git tag (`vX.Y.Z`) rồi install với `#vX.Y.Z`. Kiểm tra đã load: `omp -p '/opsx-auto'` (command do extension đăng ký; dispatch im lặng ~2s = đã load, rơi xuống model = chưa).

**2) Trong project (không cần node nữa):**

- Project **đã có** `openspec/`: chỉ cần mở omp trong project — extension tự ghi rule vào `.omp/rules/opsx-autopilot.md` ngay session đầu (single source: `rules/` trong package), config dùng defaults. Rule active từ omp start kế tiếp.
- Project **chưa có** `openspec/`: mở omp trong project, gõ `/opsx-init` — bootstrap `openspec init --tools oh-my-pi --no-copilot-cloud` + ghi config mặc định + ensure rule.
- Tùy chỉnh config (verifyCmd, mode): sửa `.omp/opsx-autopilot.json`.

`init.mjs` vẫn giữ cho scripted/CI (`node init.mjs <target>` = openspec init + config; `--vendor` = copy cả extension + rule + config.yml cho omp build không có plugin support — **không dùng đồng thời** plugin install và `--vendor` trong cùng project).

Restart omp trong project đó là xong.

## Config — `.omp/opsx-autopilot.json`

```json
{ "enabled": true, "mode": "auto", "autoApply": true, "verifyCmd": "" }
```

| key | values | effect |
|---|---|---|
| `enabled` | bool | `false` → extension is a no-op |
| `mode` | `"auto"` \| `"suggest"` | `auto`: apply automatic, archive asks you in-chat, sync automatic. `suggest`: nudge-only, no continuations. (legacy `"confirm"` được nhận như `"auto"`) |
| `autoApply` | bool | gates the planning→apply continuation |
| `verifyCmd` | shell command, e.g. `npm test` | extra gate before archive; empty = skip |

Hành vi archive: **hỏi user, sync tự động** — sau self-review agent hỏi `Archive "<id>" now?`, bạn đồng ý thì archive + inline sync chạy luôn (luôn chọn "Sync now (recommended)"); từ chối thì change giữ nguyên.

Lệnh của extension:
- `/opsx-init` — bootstrap `openspec init` (project mới) + ghi config mặc định + ensure rule.
- `/opsx-update` — chạy `openspec update --force`: tái sinh skills/commands theo CLI mới (chạy sau khi nâng cấp openspec).
- `/opsx-auto` — probe trạng thái + gates + fire-keys (debug).

## Uninstall

- Plugin: `omp plugin uninstall opsx-autopilot` (hoặc gỡ `--extension` khỏi config).
- Project: xóa `.omp/rules/opsx-autopilot.md`, `.omp/opsx-autopilot.json` (+ `.omp/extensions/opsx-autopilot.ts` và entry trong `config.yml` nếu dùng `--vendor`).
- OpenSpec itself is untouched.

## Scope

OMP-only by decision. The pack pattern (extension + rule + initializer) ports trivially to other harnesses if ever needed.
