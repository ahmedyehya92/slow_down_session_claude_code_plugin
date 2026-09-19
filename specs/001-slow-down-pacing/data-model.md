# Data Model: Slow-Down Pacing Mode

Entities, fields, validation rules, and state transitions. Source of truth: `specs/001-slow-down-pacing/spec.md` (FR-005/007/014/015) and `research.md` decisions R3/R4.

---

## 1. Pacing Configuration (persisted, read-only to the plugin)

Stored in settings files; the plugin never writes them. Two layers, resolved per key (project wins):

| Field | Type | Default | Validation (FR-007) | Layer |
|---|---|---|---|---|
| `workMinutes` | number | `5` | MUST be `> 0` and finite | global → project |
| `pauseMinutes` | number | `4` | MUST be `> 0` and finite | global → project |

Locations:
- User-global: `~/.claude/settings.json` → top-level key `"slowDownPacing"`
- Per-project: `<project>/.claude/settings.json` → top-level key `"slowDownPacing"`

**Rules**:
- **R-CONF-1** (FR-014): each key resolves independently — project value if present and valid, else global value, else default.
- **R-CONF-2** (FR-007): if any resolved duration fails validation (`≤ 0`, non-number, non-finite), the **entire configuration is treated as disabled** for that evaluation: the hook exits 0 immediately (no pause ever) and, once per session, emits a `systemMessage` (user-only) describing the misconfiguration. Unknown keys are ignored.
- **R-CONF-3**: enabled/disabled state is **not** stored here (see Session Pacing State).
- The pause spinner text is NOT configurable: it is the static `statusMessage` field in `hooks/hooks.json`, which Claude Code reads at plugin load. Time-remaining visibility is provided by `/slow-down-pacing:status` (FR-009).

## 2. Session Pacing State (per-session, ephemeral by convention)

One JSON file per session: `${CLAUDE_PLUGIN_DATA}/sessions/<session_id>.json`. Written only by the plugin.

| Field | Type | Description |
|---|---|---|
| `sessionId` | string | Must match the filename and the hook's stdin `session_id`; mismatch → treat file as absent |
| `enabled` | boolean | Whether pacing is active for this session |
| `cycleStartedAt` | number (epoch ms) | Start of the current cycle's work phase |
| `phase` | `"work" \| "pause"` | Current (last-computed) phase — informational only; truth is recomputed from wall clock at every hook run |

Plus a single pending-intent file `${CLAUDE_PLUGIN_DATA}/sessions/pending.json`:

| Field | Type | Description |
|---|---|---|
| `action` | `"enable" \| "disable"` | Requested change |
| `requestedAt` | number (epoch ms) | Written by `/on` or `/off`; used for pruning (> 24 h old → discard) |

**Rules**:
- **R-STATE-1** (FR-015): a session's state file never outlives its usefulness — a new session has a new `session_id`, finds no file, and starts **disabled**. No enable/configure state ever carries into a later session.
- **R-STATE-2** (adoption, FR-006): when a hook runs and `pending.json` exists, it is applied to the running session's state and deleted. `enable` → creates/updates state with `enabled: true`, `phase: "work"`, `cycleStartedAt: now` (fresh cycle, FR/edge: enable mid-session). `disable` → sets `enabled: false` (an in-progress pause is allowed to complete naturally — the current sleep is already in flight; the *next* hook run sees disabled). Re-`enable` while already enabled (valid anchor) is a **no-op adoption**: the intent is consumed but the running cycle is left untouched (plugin-surface §4 `/on` idempotence) — a fresh cycle starts only on an actual transition (never-enabled, disabled, unreadable, or mismatched state). Stale intents are pruned regardless of session scope, and complete-but-invalid intents (unknown `action`) are pruned the same way; only a fresh, valid intent scoped to another session is preserved (qodo PR #7).
- **R-STATE-3** (FR-013, rapid toggles): every adoption recomputes state from the file contents; there are no in-memory timers to orphan. Any sequence of `/on` `/off` `/on` converges: the last adopted action wins by the next hook run.
- **R-STATE-4** (privacy/Model Silence): state files are never read into the model context; only scripts touch them.

## 3. Cycle (derived, not stored)

One work phase followed by one pause phase, repeating while enabled. Derived at each Stop-hook run from wall clock + state + config:

```text
elapsed = now − cycleStartedAt
if elapsed < workMinutes*60000          → phase = work      → hook exits 0 (no-op)
else
  pauseElapsed = elapsed − workMinutes*60000
  if pauseElapsed < pauseMinutes*60000  → phase = pause     → sleep remaining pause ms → exit 0 (silent)
  else                                  → cycle complete    → write next cycle (cycleStartedAt += cycle length) → exit 0
```

**State transitions**:

| From | Event | To |
|---|---|---|
| (no state) | `/on` → adoption at next hook run | `work` @ now |
| `work` | turn ends before work elapses | `work` (no-op exit) |
| `work` | turn ends, work elapsed | `pause` (sleep remaining; FR-002a automatic — Stop fires only after the task finished) |
| `pause` | sleep completes | next cycle `work` (cycleStartedAt advanced by full cycle length — FR-011 continuous timer) |
| `pause` | user Esc (hook aborted) | session returns to user; no state write needed — next hook run recomputes from wall clock |
| any | `/off` → adoption | disabled (no pauses until re-enabled) |
| any | invalid config detected (R-CONF-2) | disabled-behavior for that session + user-only notice (FR-007/FR-008) |

**Determinism** (FR-011): with fixed config, phase boundaries depend only on `cycleStartedAt` and durations — identical across runs, ±2 s scheduling tolerance. Idle time consumes cycle time because the clock is wall-clock, not activity-clock (clarified Q2).

## 4. Hook Input (read-only, from Claude Code stdin JSON)

| Field | Used for |
|---|---|
| `session_id` | state file key; must match `sessionId` |
| `hook_event_name` | assert `Stop`; any other value → exit 0 no-op |
| `stop_hook_active` | if `true` (already continuing from a Stop hook), exit 0 no-op (defensive) |

**Never emitted by the plugin**: `decision`, `reason`, `continue: false`, `hookSpecificOutput` (Model Silence, Principle II). Only permitted outputs: exit 0 with empty streams; exit 0 with `{"systemMessage": …}` for the FR-007 human-only misconfiguration notice.
