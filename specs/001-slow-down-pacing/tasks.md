---
description: "Task list for Slow-Down Pacing Mode implementation"
---

# Tasks: Slow-Down Pacing Mode

**Input**: Design documents from `/specs/001-slow-down-pacing/`

**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/plugin-surface.md, quickstart.md

**Tests**: Included. plan.md explicitly specifies `node:test` unit tests (cycle math, config resolution, state adoption) and black-box integration tests of `pacing.mjs` (exit 0 + empty output contract). Tests are written first and must FAIL before the implementation they cover.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single plugin project** (per plan.md): `.claude-plugin/`, `hooks/`, `scripts/`, `commands/`, `tests/` at repository root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Plugin skeleton, manifest, and test harness wiring

- [X] T001 Create the project directory structure exactly as in plan.md: `.claude-plugin/`, `hooks/`, `scripts/`, `commands/`, `tests/unit/`, `tests/integration/`
- [X] T002 [P] Create `package.json` at repo root with `"type": "module"`, `"private": true`, no runtime dependencies, and a `"test"` script running `node --test "tests/**/*.test.mjs"` (quoted glob — positional directory args like `node --test tests/` fail with MODULE_NOT_FOUND on Node ≥ 21, verified on v25.2.0; dev/test harness requires Node ≥ 21 for glob support, so `engines.node` is `>=21` — plugin scripts themselves use only baseline ESM; zero npm deps per plan.md)
- [X] T003 [P] Create `.claude-plugin/plugin.json` exactly per contracts/plugin-surface.md §1: `name: "slow-down-pacing"` (the slash-command namespace `/slow-down-pacing:*`), `version: "0.1.0"`, `displayName: "Slow-Down Pacing"`, description, `author.name: "Ahmed Yehya"`, `license: "MIT"`; no `hooks` path override (default `hooks/hooks.json` applies)

**Checkpoint**: Plugin skeleton exists and `npm test` (→ `node --test "tests/**/*.test.mjs"`) runs green, anchored by the `tests/unit/skeleton.test.mjs` placeholder (a bare glob with zero matches is not reliably green across Node versions)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Hook registration and the session-state primitives every user story depends on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T004 Create `hooks/hooks.json` exactly per contracts/plugin-surface.md §2: a single `Stop` event with one command hook — `"command": "node"`, `"args": ["${CLAUDE_PLUGIN_ROOT}/scripts/pacing.mjs"]` (exec form, no shell), `"timeout": 86400` (seconds; MUST exceed the largest sensible pause — a timeout kill degrades to "pause skipped", FR-008), `"statusMessage": "Slow-down pacing: pausing…"`, `"async": false`. The hook NEVER registers on any other event in v1
- [X] T005 [P] Implement session-state primitives in `scripts/state.mjs`: resolve state dir from `CLAUDE_PLUGIN_DATA` (fallback: fail closed → treat as no state), `readState(session_id)` returning parsed `<dir>/sessions/<session_id>.json` or `null`, `writeState()` performing an atomic write (temp file + rename) of `{ sessionId, enabled, phase, cycleStartedAt }`, `readPending()`/`writePending()` for `<dir>/sessions/pending.json` (`{ action: "enable"|"disable", requestedAt }`), and `deletePending()`. State files are only ever touched by scripts — never printed to stdout (data-model §2 R-STATE-4, Constitution Principle II)

**Checkpoint**: Hook registration compiles and state primitives are importable; user story implementation can now begin

---

## Phase 3: User Story 1 — Deterministic Work/Pause Cycle (Priority: P1) 🎯 MVP

**Goal**: A wall-clock repeating cycle: work phase (no-op) → pause phase (hook sleeps the remaining pause time) → next cycle, driven purely by timestamps and configured durations.

**Independent Test**: Enable pacing (a hand-written state file is sufficient at this stage), run the hook binary with synthetic stdin JSON and a fake clock, and verify: within the work window → immediate exit 0 no-op; after the work duration elapses and the task finished (Stop fires) → hook sleeps the full pause duration; after the pause → state advances to the next cycle's work phase. A second pass of the same inputs confirms repetition.

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T006 [P] [US1] Write `tests/unit/cycle.test.mjs` for the pure cycle state machine (FR-001/FR-002/FR-002a/FR-011): phase computed from `cycleStartedAt` + durations alone; elapsed < workMinutes → phase `work`; elapsed in [work, work+pause) → phase `pause` with correct remaining ms; elapsed ≥ full cycle → `work` of next cycle with `cycleStartedAt` advanced by exactly one full cycle length (continuous wall-clock timer, FR-011 — idle time consumes cycle time); work-phase overrun tolerated (pause begins only on Stop, i.e. after the task finished — FR-002a); boundaries deterministic within ±2 s tolerance; time source injectable so `SLOW_DOWN_TIME_SCALE` makes 5/4-minute cycles testable in milliseconds (research R6) — include an FR-010a case: simulate a hook aborted mid-pause (no post-sleep state write) and assert the next run recomputes the phase purely from `cycleStartedAt` + wall clock, producing a fresh work phase rather than a stale pause
- [X] T007 [P] [US1] Write `tests/integration/hook.test.mjs` black-box suite (part 1): pipe stdin JSON `{"session_id": "...", "hook_event_name": "Stop", "stop_hook_active": false}` into `node scripts/pacing.mjs` with `CLAUDE_PLUGIN_DATA` pointed at a temp dir — during the work phase asserts exit 0 with empty stdout AND empty stderr, near-instant; during the pause phase asserts exit 0, empty stdout/stderr, and wall-clock elapsed ≈ scaled pause duration (±2 s). Also asserts `hook_event_name ≠ "Stop"` and `stop_hook_active: true` both yield exit 0 no-op immediately (data-model §4)

### Implementation for User Story 1

- [X] T008 [US1] Implement the cycle state machine in `scripts/pacing.mjs` (pure, exported for tests): `computePhase(state, config, now)` → `{ phase, remainingMs, nextCycleStartedAt }` per data-model §3 transition table — phase from `cycleStartedAt` and configured durations only, no randomness, no hidden state (Constitution III); accept an injectable `now`/time-scale so unit tests run in milliseconds
- [X] T009 [US1] Implement the pause sleep in `scripts/pacing.mjs`: during the pause phase, sleep for the remaining pause ms via **sliced timers against a fixed wall-clock deadline** (~1 s `setTimeout` slices, deadline re-checked each slice — review F1 rejected the original `setImmediate` busy loop, which measured 101% of a core per pause; signals deliver between event-loop turns, so killability is identical, verified by the integration kill test), scaled by `SLOW_DOWN_TIME_SCALE`, then advance `cycleStartedAt` by exactly one full cycle length via `writeState()` (next cycle = `work`), then exit `0`. If the process is killed by the hook timeout or Esc interrupts it, nothing is written and the next hook run recomputes from the wall clock — degraded to "pause skipped", never a session error (FR-008)
- [X] T010 [US1] Wire the hook entry point in `scripts/pacing.mjs`: read stdin JSON; missing/invalid `session_id` → exit 0 no-op; `hook_event_name ≠ "Stop"` or `stop_hook_active === true` → exit 0 no-op (defensive, per data-model §4); load state via `state.mjs` — `enabled !== true` → exit 0 no-op; otherwise run the state machine (work → exit 0 immediately; pause → T009 sleep path)

**Checkpoint**: User Story 1 is fully functional and independently testable (synthetic state file drives real cycles through the black-box suite)

---

## Phase 4: User Story 2 — Model Silence During Pauses (Priority: P2)

**Goal**: Pauses contribute literally zero content to the model's conversation — no messages, tokens, tool results, turns, or reminders — on every code path, including errors.

**Independent Test**: Run the hook binary across all input shapes (valid, malformed, unknown event, missing state, mid-cycle error) and assert stdout is empty (or exactly the permitted `{"systemMessage": ...}` JSON) and stderr is always empty, with exit code 0.

### Tests for User Story 2 ⚠️

- [X] T011 [P] [US2] Extend `tests/integration/hook.test.mjs` with silence assertions (FR-004, Constitution II): for malformed/non-JSON stdin, missing fields, unknown `hook_event_name`, `stop_hook_active: true`, absent state file, and a normal pause, assert exit code 0, empty stderr on every path, stdout empty on every path except the permitted `{"systemMessage": ...}` object, and that the emitted JSON never contains `decision`, `reason`, `continue`, or `hookSpecificOutput` keys (data-model §4 "Never emitted by the plugin")

### Implementation for User Story 2

- [X] T012 [US2] Harden the output contract in `scripts/pacing.mjs`: wrap the entire hook body in a top-level try/catch whose catch exits 0 with no output (any internal error degrades to a no-op, never noise); the ONLY permitted write is one `JSON.stringify({ systemMessage })` for the FR-007 misconfiguration notice (implemented with US3); stderr is never written anywhere in any script (Constitution II)

**Checkpoint**: User Stories 1 AND 2 both work — cycles run and the model perceives nothing, on every path

---

## Phase 5: User Story 3 — Configuration Without Restart (Priority: P3)

**Goal**: Two-layer configuration (project wins per key), validation that fails safe to "no pacing", and per-session enable/disable via `/slow-down-pacing:on` and `/slow-down-pacing:off` that take effect by the next cycle boundary — no restart.

**Independent Test**: With pacing enabled, change `workMinutes`/`pauseMinutes` in settings files and/or write a `pending.json` disable intent; run the hook again and verify the next cycle honors the new values/state without interruption.

### Tests for User Story 3 ⚠️

- [X] T013 [P] [US3] Write `tests/unit/config.test.mjs` (FR-005, FR-007, FR-014; data-model §1): per-key independent resolution project → global → default (`workMinutes` 5, `pauseMinutes` 4); any resolved duration that is non-numeric, non-finite, or ≤ 0 invalidates the ENTIRE configuration → `{ disabled: true, notice }` (R-CONF-2); unknown keys (including any user-supplied `statusMessage` key) ignored; settings files the plugin can't parse → same fail-safe disabled treatment; resolution reads `~/.claude/settings.json` and `<project>/.claude/settings.json` under the `"slowDownPacing"` key (paths overridable for tests)
- [X] T014 [P] [US3] Write `tests/unit/state.test.mjs` (FR-006, FR-013, FR-015; data-model §2): adoption — a `pending.json` `{action:"enable"}` causes the next state read to produce `{enabled: true, phase: "work", cycleStartedAt: now}` and deletes the pending file; `{action:"disable"}` sets `enabled: false` and deletes the pending file; stale pending (> 24 h `requestedAt`) is pruned, not applied; session isolation — a fresh `session_id` finds no state file and resolves to pacing disabled (R-STATE-1); recomputation is stateless — no in-memory timers can be orphaned (R-STATE-3)

### Implementation for User Story 3

- [X] T015 [P] [US3] Implement `scripts/config.mjs`: two-layer resolution and validation exactly matching `tests/unit/config.test.mjs` — read both settings files, resolve each key independently (project → global → default), validate per R-CONF-2, return `{ workMs, pauseMs, sourcePerKey, disabled, noticeReason }` (the pause spinner is the static `statusMessage` in hooks.json — not a config key); the plugin never writes settings files
- [X] T016 [US3] Implement adoption in `scripts/state.mjs`: `applyPending(stateDir, sessionId, now)` per R-STATE-2/R-STATE-3 — applies pending intent to the session's state, deletes the file, prunes stale intents (> 24 h); enable → `{enabled: true, phase: "work", cycleStartedAt: now}` (fresh cycle from the work phase, no backfill); disable → `{enabled: false}`
- [X] T017 [US3] Wire configuration + adoption into `scripts/pacing.mjs`: on every hook run, call `applyPending()` first (FR-006: change effective no later than next cycle boundary), then resolve config via `config.mjs` — if config is invalid/`disabled`, exit 0 immediately and surface the notice at most once per session: `executeHook` RETURNS the notice string and `runHook` performs the single permitted `{"systemMessage": ...}` stdout write only after the whole body succeeds — never write stdout mid-flow (emission point locked in by the PR #6 qodo review) — and flag it in the session state file so the notice is one-shot (data-model §1 R-CONF-2); otherwise proceed with resolved `workMs`/`pauseMs`
- [X] T018 [US3] Create `commands/on.md` per contracts/plugin-surface.md §4: slash command `/slow-down-pacing:on` writes `pending.json` `{action: "enable", requestedAt: now}` under `CLAUDE_PLUGIN_DATA` (create the sessions dir if needed), confirms to the user with current durations and "pacing begins after your next exchange"; idempotent — re-running while enabled is a no-op confirmation. Command text instructs the model ONLY to run the write script/one-liner; it must never read or echo state file contents
- [X] T019 [US3] Create `commands/off.md` per contracts/plugin-surface.md §4: `/slow-down-pacing:off` writes `pending.json` `{action: "disable", requestedAt: now}`; confirms to the user and notes any in-progress pause completes naturally (FR-006 acceptance 4)

**Checkpoint**: User Stories 1, 2 AND 3 all work — a real session can enable/disable and reconfigure pacing live, with invalid config degrading safely to a user-only notice

---

## Phase 6: User Story 4 — Visible Pacing State for the Human (Priority: P4)

**Goal**: The human can always tell whether pacing is active, the current phase, and time remaining — via the pause spinner (`statusMessage`) and `/slow-down-pacing:status` — with zero model-visible cost.

**Independent Test**: Enable pacing, run `/slow-down-pacing:status` at several points in a cycle and observe the pause spinner; confirm the report matches wall-clock reality and that neither surface contributes anything to the model conversation.

### Tests for User Story 4 ⚠️

- [X] T020 [P] [US4] Add status-report coverage to `tests/unit/state.test.mjs` (or a small `tests/unit/status.test.mjs`): the status projection returns `{ enabled, phase, remainingInPhaseMs, workMs, pauseMs, sourcePerKey }` correctly for enabled-mid-cycle, enabled-at-cycle-start, disabled-state-file, and never-enabled (projection returns enabled false with a "pacing is off (default)" marker) — read-only, writes nothing

### Implementation for User Story 4

- [X] T021 [US4] Create `commands/status.md` per contracts/plugin-surface.md §4: `/slow-down-pacing:status` is strictly read-only — prints enabled/disabled, current phase, time remaining in phase, work/pause durations, and whether each duration came from project or global config; when pacing has never been enabled prints "pacing is off (default)"; command text must not cause any state writes (review F1/F2 phase 6: invalid config R-CONF-2 → "NOT running — configuration invalid" with the reason, taking precedence over the never-enabled marker; unresolvable session id → stderr error + exit 1, never a false "off")
- [X] T022 [US4] Add the human-visible status projection to `scripts/state.mjs`/`scripts/pacing.mjs` (exported `projectStatus(sessionId, config, now)`): reuses `computePhase` from T008 for phase + remaining; confirm the pause surface is exactly the static `hooks/hooks.json` `statusMessage` spinner plus `/slow-down-pacing:status`, and that neither can reach the model (FR-009, US2)

**Checkpoint**: All user stories independently functional — pacing cycles, silent to the model, configurable live, visible to the human

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Full-suite validation, plugin validation, and constitution re-check

- [ ] T023 Run the complete automated suite: `npm test` (→ `node --test "tests/**/*.test.mjs"`; positional directory args like `node --test tests/` fail with MODULE_NOT_FOUND on Node ≥ 21 — see T002) — all green, including the empty-output exit-0 contract and `SLOW_DOWN_TIME_SCALE`-scaled 5/4 cadence assertions (quickstart.md §0)
- [ ] T024 Run `claude plugin validate . --strict` and confirm manifest + hooks.json validation passes with no hook errors (quickstart.md §1)
- [ ] T025 Execute the quickstart.md manual scenarios end-to-end on a live session: §2 default-off guarantee, §3 one full 5/4 cycle with zero context gain, §4/§5 multi-cycle + shortened-duration behavior, §6 misconfiguration safety (user-only notice, no pauses), §7 session isolation (session B never pauses), §8 interrupt/shutdown precedence, §9 input during a pause breaks it short (FR-010a)
- [ ] T026 Constitution re-check against `.specify/memory/constitution.md`: verify no code path signals, kills, or writes to the session process (I), zero model-visible output outside slash-command turns (II), wall-clock-only determinism (III), both human surfaces present (IV), and no new dependencies/daemons added beyond the 3 scripts + 3 commands (V); record evidence in plan.md's constitution table

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories (hook registration T004 and state primitives T005)
- **US1 (Phase 3)**: Depends on Foundational. MVP — do this first.
- **US2 (Phase 4)**: Extends US1's black-box suite; depends on T007 (suite exists) and T008–T010 (paths to assert)
- **US3 (Phase 5)**: Depends on Foundational; its wiring (T017) builds on US1's entry point and US2's systemMessage channel. T013/T015 (config) are independent of the cycle and could start in parallel with US1 if staffed
- **US4 (Phase 6)**: Depends on T008 (computePhase) and T015 (config source labels)
- **Polish (Phase 7)**: Depends on all user stories complete

### User Story Dependencies

- **US1 (P1)**: Foundational only — no dependencies on other stories
- **US2 (P2)**: Tightest coupling to US1 (same script, same suite) — implement immediately after US1, before moving on
- **US3 (P3)**: Independent testable; integrates with US1/US2 at T017 but remains independently verifiable
- **US4 (P4)**: Independent; consumes T008 + T015 outputs only

### Within Each User Story

- Tests written first and failing (T006/T007, T011, T013/T014, T020) before their implementations
- Pure logic before wiring: state machine (T008) → sleep (T009) → entry point (T010)
- Commands (T018/T019/T021) after the scripts they invoke

### Parallel Opportunities

- Phase 1: T002, T003 in parallel (different files)
- Phase 2: T005 in parallel with T004
- Within each story: all test files marked [P] (T006+T007, T013+T014, T011, T020) can be written in parallel
- T013/T015 (config layer) is fully independent of the cycle work — a second implementer could own US3's config half while US1 proceeds
- US4's T020/T021 can proceed once T008 and T015 land, independent of US3's command files

---

## Parallel Example: User Story 1

```bash
# Launch both test files for US1 together:
Task: "Write tests/unit/cycle.test.mjs (T006)"
Task: "Write tests/integration/hook.test.mjs (T007)"

# Then, sequentially (same file):
Task: "Implement cycle state machine in scripts/pacing.mjs (T008)"
Task: "Implement pause sleep in scripts/pacing.mjs (T009)"
Task: "Wire hook entry point in scripts/pacing.mjs (T010)"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: US1 (cycle)
4. **STOP and VALIDATE**: run `node --test tests/` plus a live session with a hand-crafted state file
5. US2 immediately after — it hardens the same script and is what makes the cycle safe to ship

### Incremental Delivery

1. Setup + Foundational → skeleton ready
2. US1 + US2 → a working, silent 5/4 cycle (the actual feature!) → validate
3. US3 → live on/off + configuration, fail-safe validation → validate
4. US4 → `/status` + spinner polish → validate
5. Phase 7 → full quickstart pass + constitution evidence

### Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing
- Commit after each task or logical group
- Stop at any checkpoint to validate a story independently
- Never widen scope: no daemon, no MCP server, no extra hook events, no npm dependencies (plan.md Constitution Check V)
