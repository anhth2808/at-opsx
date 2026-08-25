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

**Invariant:** OpenSpec core stays 100% untouched. The extension never writes files, never blocks tools, and never runs `openspec archive` itself — every mutation flows through the agent executing OpenSpec skills/CLI. Nothing lives under the generated `.omp/skills/` or `.omp/commands/` trees, so `openspec update` can regenerate them freely.

## Repo layout (omp extension package)

```
package.json                    ← omp.extensions manifest → ./src/main.ts
src/main.ts                     ← extension factory (ExtensionAPI)
assets/rules/opsx-autopilot.md   ← project-scoped routing rule (NOT a capability folder — copied in by init.mjs)
config/opsx-autopilot.json      ← default project config (copied in by init.mjs)
init.mjs                        ← per-project initializer (openspec init + rule + config)
.claude-plugin/marketplace.json ← marketplace catalog
```

## Install (kiểu git)

Yêu cầu: Node ≥ 20, `openspec` (1.9.0 đã kiểm chứng) trên PATH.

**1) Load extension (chọn MỘT cách):**

```bash
# git-direct (đơn giản nhất — repo public, tag phải tồn tại):
omp install github:anhth2808/at-ospx#v0.1.0
# hoặc https git URL:
omp install https://github.com/anhth2808/at-ospx.git
# hoặc từ checkout local (Windows cần Developer Mode vì dùng symlink):
git clone https://github.com/anhth2808/at-ospx && omp install ./at-ospx
# hoặc qua marketplace:
omp plugin marketplace add anhth2808/at-ospx
omp install opsx-autopilot@at-opsx
# hoặc one-shot:
omp --extension ./src/main.ts
```

Ghi chú: git-direct resolve qua GitHub tarball API nên **không** nhận `file://` local; plugin id luôn là `opsx-autopilot` (theo `package.json`), bất kể tên repo. Extension no-op hoàn toàn ở project không có `openspec/` nên để user scope là an toàn. Phiên bản: bump `package.json` + `.claude-plugin/marketplace.json` + git tag (`vX.Y.Z`) rồi install với `#vX.Y.Z`. Kiểm tra đã load: `omp -p '/opsx-auto'` (command do extension đăng ký).

**2) Khởi tạo per-project (một lệnh):**

```bash
node <repo>/init.mjs <target-dir>
```

- chạy `openspec init --tools oh-my-pi --no-copilot-cloud` nếu project chưa có `openspec/` (idempotent),
- copy `assets/rules/opsx-autopilot.md` → `<target>/.omp/rules/` (rule luôn project-scoped — không nhiễu project khác; đặt ngoài thư mục `rules/` của repo để plugin không nhặt global),
- copy `config/opsx-autopilot.json` → `<target>/.omp/opsx-autopilot.json` (skip nếu có, trừ `--force`).

`--vendor`: cho omp build không có plugin support — copy thêm `src/main.ts` vào `<target>/.omp/extensions/` + merge `.omp/config.yml`. **Không dùng đồng thời plugin install và `--vendor`** trong cùng project (đăng ký kép).

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

Debug aid: lệnh `/opsx-auto` probe trạng thái + gates + fire-keys.

## Uninstall

- Plugin: `omp plugin uninstall opsx-autopilot` (hoặc gỡ `--extension` khỏi config).
- Project: xóa `.omp/rules/opsx-autopilot.md`, `.omp/opsx-autopilot.json` (+ `.omp/extensions/opsx-autopilot.ts` và entry trong `config.yml` nếu dùng `--vendor`).
- OpenSpec itself is untouched.

## Scope

OMP-only by decision. The pack pattern (extension + rule + initializer) ports trivially to other harnesses if ever needed.
