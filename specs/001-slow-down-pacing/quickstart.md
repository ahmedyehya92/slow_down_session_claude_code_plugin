# Quickstart: Validate Slow-Down Pacing

End-to-end validation scenarios for the plugin. Prerequisites: Claude Code ≥ 2.1; Node ≥ 18 at runtime, Node ≥ 21 to run the §0 test suite (quoted-glob discovery — see plan.md T002). Implementation details live in [plan.md](./plan.md) and [contracts/plugin-surface.md](./contracts/plugin-surface.md).

## 0. Automated test suite

```bash
npm test                     # → node --test "tests/**/*.test.mjs": unit + integration, seconds (fake clock)
node --test "tests/unit/*.test.mjs"   # cycle math, config resolution, state adoption
```

Expected: all green. The integration suite asserts the hook's **empty-output exit-0 contract** (model silence) and that `SLOW_DOWN_TIME_SCALE`-scaled sleeps match the 5/4 cadence.

## 1. Install (dev mode)

```bash
claude --plugin-dir /path/to/slow_down_session_claude_code_plugin
```

Then inside Claude Code:

```bash
claude plugin validate . --strict   # from the repo root; manifest + hooks.json schema
```

Expected: plugin loads, no hook errors in `/hooks`; validation passes.

**PATH caveat (nvm/fnm users).** The hook spawns `node` directly (exec form, no shell), so it resolves from Claude Code's hook-spawn environment — not your interactive shell. If `node` is managed by nvm/fnm and does not resolve there, the hook fails to spawn and pacing **silently degrades to "pause skipped"** (FR-008) with no diagnostic on screen. Ensure a stable `node` on the harness PATH (e.g. `nvm alias default <version>` and launch Claude Code from a shell where it resolves, or symlink into `~/.local/bin`), then confirm `/hooks` shows no hook errors after a paced turn.

**Persistent install (marketplace).** The repo ships a `.claude-plugin/marketplace.json`, so it can be installed without the per-session flag:

```bash
claude plugin marketplace add ahmedyehya92/slow_down_session_claude_code_plugin   # or a local path to the clone
claude plugin install slow-down-pacing@slow-down-pacing
```

Verify with `claude plugin list`; remove with `claude plugin uninstall slow-down-pacing@slow-down-pacing`.

## 2. Default-off guarantee (FR-015, SC-007)

1. Start a fresh session (`claude --plugin-dir …`).
2. Run `/slow-down-pacing:status`.
3. **Expected**: "pacing is off (default)".
4. Run several normal prompts; confirm no pause spinner ever appears.

## 3. One full 5/4 cycle (FR-001/002, SC-001)

1. Run `/slow-down-pacing:on`.
2. Give the agent a multi-step task (e.g., "read every file in specs/ and summarize").
3. **Expected**: agent works ~5 min; at the next turn end, a spinner shows "Slow-down pacing: pausing…" for ~4 min; the session stays alive and responsive; **the transcript/context gains zero pacing content** — verify with `/context` or by checking the transcript file for any pacing-related entry (must be none).
4. After the pause, send another prompt; work continues normally, no restart, no context loss (SC-003).

## 4. User override of a pause (FR-010a)

1. While the pause spinner is running, press `Esc` and type a new prompt.
2. **Expected**: control returns immediately; the agent answers; no input loss, no hook error.

## 5. Reconfigure without restart (FR-006, SC-004)

1. Edit `<project>/.claude/settings.json` → `{"slowDownPacing": {"workMinutes": 1, "pauseMinutes": 1}}` while the session runs.
2. Continue working ≥ 2 more cycles.
3. **Expected**: subsequent pauses last ~1 min (spinner + wall clock), session never interrupted.

## 6. Misconfiguration safety (FR-007, SC-005)

1. Set `{"slowDownPacing": {"pauseMinutes": 0}}` in project settings.
2. Start a session, enable pacing, work normally.
3. **Expected**: no pauses occur; a user-only notice about invalid configuration appears; the session behaves normally; nothing invalid reaches the model context.

## 7. Session isolation (FR-015)

1. With pacing enabled in session A, start session B (same machine).
2. In B, run `/slow-down-pacing:status`.
3. **Expected**: "pacing is off (default)"; B never pauses.

## 8. Interrupt/shutdown precedence (FR-012)

1. Enable pacing, trigger a pause, then exit the session (`Ctrl+C` twice / `exit`).
2. **Expected**: session exits immediately; the pending hook does not delay shutdown; relaunching shows pacing off (default).

## 9. Input during a pause breaks the pause short (FR-010a)

1. Enable pacing, trigger a pause (spinner visible).
2. Mid-pause, send the agent a prompt.
3. **Expected**: the spinner clears immediately — the agent responds without waiting for the pause to finish; the pause window continues on the wall clock (if the user's turn finishes while the window is still open, the remaining pause applies at the next Stop boundary; the interrupted hook persisted nothing, so the phase is always recomputed from the wall clock, never a stale pause).
4. Confirm no prompt text was lost or duplicated.
