# Slow-Down Pacing for Claude Code

Repeating work/pause cycles for your Claude Code sessions — **5 minutes of work, 4 minutes of pause, on a deterministic wall clock** — with *zero* pacing noise in the AI's context.

```
work 5 min ──▶ pause 4 min ──▶ work 5 min ──▶ pause 4 min ──▶ …
```

## Why

Long agentic sessions benefit from deliberate rhythm: enforced pauses give you a moment to review, redirect, or just breathe. The catch with most pacing tricks is that they pollute the conversation — status chatter, extra turns, tokens the model has to carry forever.

This plugin is built around **Model Silence**: the pause is a `Stop` hook that simply sleeps and exits `0` with empty output. The model's context gains nothing — no messages, no tool output, no decision fields. The only pacing surfaces are ones *you* see: the pause spinner and three slash commands. (Subagents are never paced — their completions fire `SubagentStop`, which this plugin deliberately does not register.)

## Safety guarantees

- **Session integrity** — no process kills, no signals, no transcript writes. If anything goes wrong (hook can't spawn, timeout, interrupt), the pause is simply skipped; the session is never damaged.
- **Model silence** — every hook path exits `0` with empty streams. The one permitted output is a user-only `systemMessage` misconfiguration notice (shown once per session, never to the model).
- **Deterministic** — phase is recomputed from wall clock + configured durations. No randomness, no hidden state beyond one JSON file per session.
- **Off by default** — every new session starts un-paced until you run `/slow-down-pacing:on` in it.

## Install

**Persistent (marketplace):**

```bash
claude plugin marketplace add ahmedyehya92/slow_down_session_claude_code_plugin
claude plugin install slow-down-pacing@slow-down-pacing
```

**Dev mode (from a clone):**

```bash
claude --plugin-dir /path/to/slow_down_session_claude_code_plugin
```

> **PATH caveat (nvm/fnm users):** the hook spawns `node` directly (no shell), so node must resolve from Claude Code's environment — not just your terminal. An unresolved node silently degrades to "pause skipped". Launch Claude Code from a shell where `node` resolves, or symlink it into `~/.local/bin`.

## Usage

Pacing is per-session and off by default:

| Command | Effect |
|---|---|
| `/slow-down-pacing:on` | Enable for this session (takes effect at your next exchange) |
| `/slow-down-pacing:off` | Disable; any in-progress pause completes naturally |
| `/slow-down-pacing:status` | Read-only report — enabled/disabled, current phase, time remaining |

Example `/slow-down-pacing:status` output:

```
Slow-down pacing: enabled.
Phase: work (240s remaining).
Work: 5 min (project), pause: 4 min (default).
```

During a pause, Claude Code's spinner shows *"Slow-down pacing: pausing…"*. User input during a pause breaks it short; the remaining window applies at the next turn boundary (the wall clock never resets).

## Configuration

No restart needed — settings are re-read on every hook run. Two layers, resolved per key (project wins):

**Project:** `<project>/.claude/settings.json` **Global:** `~/.claude/settings.json`

```json
{
  "slowDownPacing": {
    "workMinutes": 5,
    "pauseMinutes": 4
  }
}
```

- Each key resolves independently: project → global → default (5 / 4).
- Any invalid value (≤ 0, non-numeric, non-finite) **fails safe**: pacing is disabled for the session and you get a one-time user-only notice explaining exactly what's wrong. `/slow-down-pacing:on` reports the same problem instead of promising a cycle that will never run.
- The pause spinner text is intentionally not configurable (it loads at plugin start).

## Requirements

- Claude Code ≥ 2.1
- Node ≥ 18 at runtime; Node ≥ 21 to run the test suite

## Development

```bash
npm test                        # 80 tests: unit + black-box hook integration
claude plugin validate . --strict
```

Zero runtime dependencies (`node:test` only). This repo was built spec-first — the full requirements, contracts, data model, and decision log live in [`specs/001-slow-down-pacing/`](./specs/001-slow-down-pacing/).

## License

[MIT](./LICENSE) © Ahmed Yehya
