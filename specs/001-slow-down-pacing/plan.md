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

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|---|---|---|
| I. Session Integrity | ✅ PASS | Pause = synchronous Stop-hook command that sleeps then exits; Claude Code's own process supervisor manages the hook, never vice versa. Stop hooks do not fire on user interrupts (native shutdown precedence, FR-012). No process kills, signals, or session-file writes. |
| II. Model Silence | ✅ PASS | Exit code 0 with empty output is documented as contributing nothing to Claude's context (hooks reference). No `decision`/`reason`/`additionalContext` fields are ever emitted. The only model-visible plugin activity is the user-initiated slash-command turns (explicitly out of pause scope). |
| III. Deterministic Pacing | ✅ PASS | Wall-clock state machine: phase computed from timestamps and fixed configured durations; no randomness, no hidden state beyond the session state file. |
| IV. Human Transparency & Control | ✅ PASS | `statusMessage` shows the pause on the spinner; `/status` command reports state; `/on` `/off` toggle per session without restart. |
| V. Simplicity & Minimal Footprint | ✅ PASS | No daemon, no MCP server, no external processes beyond one short-lived hook process; ~4 source files. Complexity tracking table empty. |

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
