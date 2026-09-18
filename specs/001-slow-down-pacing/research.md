# Research: Slow-Down Pacing Mode

Researched 2026-09-18 against official Claude Code docs (code.claude.com/docs/en: hooks, plugins-reference, plugins, skills, settings, statusline, plugin-marketplaces) via delegated research agents. Local environment verified: Claude Code 2.1.277, Node v25.2.0.

## R1: Which mechanism can pause a session without interrupting it or emitting model-visible output?

**Decision**: A synchronous `Stop` hook running a Node.js script that sleeps for the remaining pause time and exits `0` with no output.

**Rationale**:
- `Stop` fires exactly when the main agent has finished responding — matching clarified requirement FR-002a ("pause begins only after the current task finishes") for free, with no timer-abort logic.
- Exit code `0` with empty stdout/stderr is documented as contributing **nothing** to Claude's context or transcript (FR-004). Paths that inject model-visible text (exit code `2` → stderr fed to Claude; `{"decision":"block","reason"}`; `hookSpecificOutput.additionalContext`) are simply never used.
- Blocking for minutes is supported: default command-hook timeout is 600 s, raisable via the per-hook `timeout` field (seconds, no documented hard cap for command hooks).
- `Stop` hooks do **not** fire on user interrupts — native support for FR-012 (shutdown/interrupt precedence) and FR-010a (Esc during a pause aborts the waiting hook and returns control to the user's input).
- Subagent turns fire `SubagentStop`, not `Stop`, so pacing naturally applies only to the main agent loop.

**Alternatives considered**:
- *`UserPromptSubmit` hook sleep* — blocks **before** every prompt (default timeout only 30 s); would delay the user's own input rather than pace the agent. Rejected.
- *Async hooks* — cannot block; async output (`systemMessage`, `additionalContext`) is passed to the **model** on the next turn, violating Model Silence. Rejected.
- *MCP server / external daemon* — violates Principle V (extra moving parts) and would need unsafe process control to "pause" anything. Rejected.
- *Exit code 2 / decision-block "make Claude wait" tricks* — inject text into the model context (constitution Principle II violation) and cap at 8 consecutive blocks. Rejected.

## R2: How is a minutes-long pause kept safe across platforms?

**Decision**: Node.js ESM script invoked in **exec form** (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/pacing.mjs", ...]`), sleeping via a millisecond timer; hook `timeout` set to a value covering the maximum configurable pause.

**Rationale**:
- Exec form bypasses shell (`sh -c` / Git Bash / PowerShell) entirely → identical behavior on Linux/macOS/Windows; no `sleep` binary dependency (FR-008 platform safety).
- Node ships with Claude Code, so availability is guaranteed wherever Claude Code runs.
- If the script itself fails or times out, Claude Code cancels the hook and the turn concludes normally — failure degrades to "pause skipped", never to a broken session (FR-008).
- Long synchronous hooks show a spinner (with optional `statusMessage` text) — the human-visible pause indicator (FR-009), at zero cost to the model.

**Alternatives considered**:
- *Bash `sleep`* — not available on stock Windows; shell-form quoting pitfalls. Rejected as primary (kept as irrelevant: exec form is shell-free).
- *PowerShell branch* — second code path to maintain (Principle V). Avoided by Node exec form.

## R3: Where do configuration values live, and how are the two layers resolved?

**Decision**: Durations live as a `slowDownPacing` object in `~/.claude/settings.json` (user-global defaults) and `<project>/.claude/settings.json` (per-project overrides). The plugin scripts resolve the layers **themselves** (read project file first, fall back per key to the global file) rather than relying on Claude Code's settings merge.

**Rationale**:
- Matches constitution constraint ("configuration in settings files") and FR-014 (global defaults + per-project overrides).
- Claude Code merges object-valued keys by **whole-key replacement** (higher tier wins entirely), so a partially specified project object could silently wipe global defaults; self-resolution guarantees per-key override semantics with ~20 lines of code.
- Reading two JSON files adds negligible startup cost.

**Alternatives considered**:
- *Rely on Claude Code settings merge* — wrong semantics for partial overrides (above). Rejected.
- *`userConfig` plugin options (`CLAUDE_PLUGIN_OPTION_*`)* — single global layer only; cannot express per-project values. Rejected.
- *Env-var config* — opaque, duplicates the settings-file constitution requirement. Rejected.

## R4: How is per-session enable state stored so it never persists to later sessions (FR-015)?

**Decision**: JSON state files at `${CLAUDE_PLUGIN_DATA}/sessions/<session_id>.json`. The Stop hook (which receives `session_id` on stdin) reads its own session's file. Slash commands don't know `session_id`, so `/on` writes a pending-intent file; the next Stop hook run in that session adopts it into the session-keyed state and deletes the pending file.

**Rationale**:
- `CLAUDE_PLUGIN_DATA` is the documented persistent plugin storage path, exported to hook processes.
- Keying by `session_id` makes cross-session leakage structurally impossible: a later session's hook looks up a different file and finds nothing → pacing off (FR-015 default-disabled), verified by SC-007.
- The one-turn adoption delay satisfies FR-006 ("changes take effect no later than the next cycle boundary").
- Stale files from crashed sessions are inert (different `session_id` never reads them) and may be pruned opportunistically (files older than N days) without affecting correctness.

**Alternatives considered**:
- *Model-provided session id in the toggle command* — the model has no reliable access to its session id; guessing would corrupt state. Rejected.
- *Single machine-wide active flag* — would leak enable state across sessions and parallel sessions; violates FR-015 and the single-session scope assumption. Rejected.
- *Env vars set by slash command* — Bash-tool env changes don't reach the hook process. Rejected.

## R5: What surfaces exist for human-visible pacing state (FR-009)?

**Decision**: (a) `statusMessage` in the Stop-hook config shows "Paused …" on the spinner during every pause; (b) `/slow-down-pacing:status` prints phase, time remaining, durations, and config source on demand; (c) README documents an optional user-installed statusline snippet reading the session state file.

**Rationale**:
- Plugins **cannot** ship the main `statusLine` (plugin settings.json supports only `agent` keys), so (a)+(b) are the native in-plugin surfaces; both are strictly user-visible.
- `systemMessage` in hook JSON output is user-only, but on `Stop` a synchronous hook is simplest kept fully silent (exit 0, no output) — reserving `systemMessage` for the human-only misconfiguration notice required by FR-007.

**Alternatives considered**:
- *Bundled statusline* — not possible for plugins. Documented as a limitation instead.
- *`terminalSequence` notifications* — out of scope for v1 (Principle V).

## R6: Testing approach for pacing logic and hook contract?

**Decision**: `node:test` (built-in). Unit tests cover the pure cycle state machine (phase math, FR-002a overrun, boundary arithmetic), config resolution/validation (FR-005/007/014), and state adoption/session isolation (FR-013/015). Integration tests run `pacing.mjs` as a black box: feed stdin JSON, fake clock via injectable time, assert exit code 0 and **empty stdout/stderr** (the model-silence contract) — with sleeps stubbed to milliseconds via a time-scale env var used only in tests.

**Rationale**: Constitution requires test-first for cycle logic, timeout handling, and no-op continue signaling; a fake-clock seam makes 5/4-minute cycles testable in milliseconds without flaky real-time sleeps. Black-box output assertions directly verify Principle II.
