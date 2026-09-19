# Contracts: Plugin Surface

The plugin's externally visible interfaces. Any change here is a breaking change for users.

---

## 1. Plugin Manifest — `.claude-plugin/plugin.json`

```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin.json",
  "name": "slow-down-pacing",
  "displayName": "Slow-Down Pacing",
  "version": "0.1.0",
  "description": "Configurable work/pause cycles for Claude Code sessions: work 5 minutes, pause 4 minutes, repeat. Silent to the model; safe for the session.",
  "author": { "name": "Ahmed Yehya" },
  "license": "MIT"
}
```

Contract: `name` is the slash-command namespace (`/slow-down-pacing:*`). No `hooks` path override (default `hooks/hooks.json` is used).

## 2. Hook Registration — `hooks/hooks.json`

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/pacing.mjs"],
            "timeout": 86400,
            "statusMessage": "Slow-down pacing: pausing…",
            "async": false
          }
        ]
      }
    ]
  }
}
```

Contract:
- Exec form (`command` + `args`): no shell involved; identical behavior on Linux/macOS/Windows.
- `timeout` (seconds) MUST exceed the largest sensible configured pause (86400 = 24 h ceiling); a timeout kill degrades to "pause skipped", never a session error (FR-008).
- `statusMessage` is the human-visible pause indicator (FR-009); it is UI-only and never reaches the model.
- The hook NEVER registers on other events in v1.

## 3. Hook Binary Contract — `scripts/pacing.mjs`

**Input**: Claude Code stdin JSON (`session_id`, `hook_event_name`, `stop_hook_active`, …). Environment: `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`.

**Output contract (verbatim guarantee, Principle II)**:
- Normal operation and every degraded path exits with code **0**.
- stdout is **empty** unless emitting the single permitted JSON: `{"systemMessage": "<user-only notice>"}` (used at most once per session for FR-007 misconfiguration).
- stderr is always empty.

**Behavior contract**:

| Condition | Behavior |
|---|---|
| stdin not valid JSON / `hook_event_name ≠ "Stop"` | exit 0, no output |
| No state file for `session_id` and no valid `pending.json` | exit 0, no output (pacing off — FR-015) |
| Config invalid (R-CONF-2) | exit 0; first time in session: `systemMessage` notice; no pause (FR-007) |
| `elapsed < work` | exit 0, no output (work phase) |
| `work ≤ elapsed < work + pause` | sleep `work + pause − elapsed` ms → exit 0, no output (FR-002a/FR-003) |
| `elapsed ≥ work + pause` | advance `cycleStartedAt` by one full cycle length, write state, exit 0 (FR-011) |
| `pending.json` present | adopt into this session's state, delete pending, then re-evaluate table from the top |
| state `sessionId ≠ stdin session_id` | treat state as absent (R-STATE-1) |

**Test seams** (production-inert): `SLOW_DOWN_TIME_SCALE` (divides sleeps, tests only), `SLOW_DOWN_NOW` (fake clock epoch ms, tests only), `SLOW_DOWN_DATA_DIR` (redirect state dir in tests), `SLOW_DOWN_GLOBAL_SETTINGS` / `SLOW_DOWN_PROJECT_SETTINGS` (override the settings-file locations in tests — a layer left unset in test mode resolves to no file; production always reads the real `~/.claude/settings.json` and `<project>/.claude/settings.json`). Scripts MUST ignore `SLOW_DOWN_TIME_SCALE`/`SLOW_DOWN_NOW`/`SLOW_DOWN_*_SETTINGS` unless `NODE_ENV === "test"`.

## 4. Slash Command Contracts (user-initiated; outside pause scope)

All commands: `disable-model-invocation: true`, `allowed-tools: Bash(node *)` scoped to the plugin scripts. They run a tiny script invocation and report the result; this is a user-requested action and not part of the pause (Model Silence applies to pauses).

### `/slow-down-pacing:on`
- Effect: writes `pending.json` `{action: "enable", requestedAt: now}` under `CLAUDE_PLUGIN_DATA`.
- Output to user: confirmation + current durations + "pacing begins after your next exchange".
- Idempotent: re-running while enabled is a no-op confirmation.

### `/slow-down-pacing:off`
- Effect: writes `pending.json` `{action: "disable", requestedAt: now}`.
- Output to user: confirmation; notes any in-progress pause completes naturally (FR-006 acceptance 4).

### `/slow-down-pacing:status`
- Effect: read-only — prints enabled/disabled, current phase, time remaining in phase, work/pause durations, and whether each came from project or global config.
- MUST be safe when pacing has never been enabled (prints "pacing is off (default)").

## 5. Configuration Contract (settings files)

```json
// ~/.claude/settings.json (user-global defaults)
{ "slowDownPacing": { "workMinutes": 5, "pauseMinutes": 4 } }

// <project>/.claude/settings.json (per-project override)
{ "slowDownPacing": { "pauseMinutes": 10 } }
```

- Per-key resolution: project → global → default (`workMinutes` 5, `pauseMinutes` 4).
- Unknown keys ignored; invalid durations (≤ 0, non-numeric, non-finite) disable pacing for the session with a user-only notice (FR-007).
- The plugin never writes these files.
