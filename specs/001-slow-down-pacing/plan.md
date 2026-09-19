# Implementation Plan: Slow-Down Pacing Mode

**Branch**: `001-slow-down-pacing` | **Date**: 2026-09-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-slow-down-pacing/spec.md`

## Summary

A Claude Code plugin that paces sessions with a repeating work/pause cycle (default 5 min work / 4 min pause). The pause is implemented as a synchronous Stop-hook command that sleeps for the remaining pause time and exits 0 with no output — the one path Claude Code guarantees is 100% silent to the AI model and non-interrupting to the session. Configuration (work/pause durations) persists in user-global and project settings files (project wins per key); the enabled state is per-session, always off at session start, and managed via plugin slash commands. The human sees pacing through the hook's `statusMessage` spinner text and a `/status` command; nothing ever enters the model's context because of pacing.

## Technical Context

**Language/Version**: JavaScript (Node.js ≥ 18, ESM) — Node is bundled with every Claude Code installation, guaranteeing availability on Linux, macOS, and Windows without extra dependencies.

**Primary Dependencies**: Claude Code 2.x extension surfaces only: plugin manifest (`.claude-plugin/plugin.json`), hooks (`hooks/hooks.json`, `Stop` event), plugin slash commands (`commands/*.md`). Zero runtime npm dependencies (node:test for testing).

**Storage**: JSON state files per session under `${CLAUDE_PLUGIN_DATA}/sessions/<session_id>.json` (ephemeral by convention; keyed per session so nothing persists into later sessions). Configuration read from `~/.claude/settings.json` and `<project>/.claude/settings.json` (plugin resolves the two layers itself for per-key override semantics).

**Testing**: node:test (built-in runner) — unit tests for the cycle/state machine and config resolution; integration tests exercise the hook script as a black box via stdin JSON.

**Target Platform**: Claude Code CLI on Linux, macOS, Windows (Node exec-form hooks avoid shell differences; no `sleep` binary dependency).

**Project Type**: Claude Code plugin (single project).

**Performance Goals**: Hook script startup < 200 ms; pause-phase wall-clock drift within ±2 s of the configured pause duration.

**Constraints**: Never kill/signal/modify the session process; zero model-visible output during pauses; hook `timeout` must exceed the maximum configured pause; degraded environments (missing Node, denied execution) MUST skip the pause (FR-008).

**Scale/Scope**: Single-session scope; 2 scripts, 3 slash commands, 1 hooks config, unit + integration tests.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design. Phase 7 re-check (T026): 2026-09-19.*

| Principle | Status | Evidence |
|---|---|---|
| I. Session Integrity | ✅ PASS | Pause = synchronous Stop-hook sleep then exit 0 (`scripts/pacing.mjs`); plugin never calls `process.kill` / never spawns children / never writes session transcripts — only `${CLAUDE_PLUGIN_DATA}/sessions/*`. Mid-pause SIGTERM leaves state untouched (live data-dir kill + integration kill test, FR-008/FR-010a). Only `Stop` is registered (`hooks/hooks.json`); FR-012 shutdown precedence is harness-native. |
| II. Model Silence | ✅ PASS | Hook: exit 0, empty stderr; stdout empty or exactly `{"systemMessage"}` (FR-007 one-shot). Never emits `decision`/`reason`/`continue`/`hookSpecificOutput` (US2 suite, 80/80 `npm test`). Slash commands are `disable-model-invocation: true`. Live glm transcripts (2026-09-19): no pause-spinner text in assistant turns; no `systemMessage` leakage into model context. |
| III. Deterministic Pacing | ✅ PASS | Pure `computePhase(state, config, now)` wall-clock math; no `Math.random`. Live proof: 0.05/0.05 settings → Stop-hook pause wall-clock **2973 ms** vs 3000 ms expected; cycle boundary advanced exactly one cycle. |
| IV. Human Transparency & Control | ✅ PASS | Spinner: `hooks/hooks.json` `statusMessage` = "Slow-down pacing: pausing…". Live glm: `/on` wrote pending then Stop adopted `{enabled:true, phase:work}`; status reports off(default) / enabled correctly; `/on` `/off` `/status` present under `commands/`. |
| V. Simplicity & Minimal Footprint | ✅ PASS | Locked footprint: 3 scripts + 3 commands + 1 hooks.json + 1 manifest; zero runtime npm deps. `claude plugin validate . --strict` → Validation passed (T024). No daemon/MCP; every feature traces to a stated user need (US1–US4) — no unjustified complexity (constitution V; review F2: reworded — no complexity *table* exists, the constitution requires spec-justified complexity, which spec.md/plan.md record). |

## Project Structure

```text
.claude-plugin/
└── plugin.json              # manifest: name, version, description
hooks/
└── hooks.json               # Stop hook → node exec-form, timeout, statusMessage
scripts/
├── pacing.mjs               # entry: config resolution + cycle state machine + pause sleep
├── state.mjs                # session state file read/write, session adoption
└── config.mjs               # two-layer settings resolution + validation (FR-007)
commands/
├── on.md                    # /slow-down-pacing:on  (per-session enable)
├── off.md                   # /slow-down-pacing:off (per-session disable)
└── status.md                # /slow-down-pacing:status (human-visible report)
tests/
├── unit/
│   ├── config.test.mjs      # FR-005, FR-007, FR-014
│   ├── cycle.test.mjs       # FR-001/002/002a/011 (pure state machine)
│   └── state.test.mjs       # FR-013, FR-015 (adoption, session isolation)
└── integration/
    └── hook.test.mjs        # black-box: stdin JSON → sleep/no-op → exit 0, empty output
```

**Structure Decision**: Single plugin project (Option 1). The plugin root is the repository root; no monorepo or app/service split is warranted for 4 source files.
