# Feature Specification: Slow-Down Pacing Mode

**Feature Branch**: `001-slow-down-pacing`
**Created**: 2026-09-18
**Status**: Draft
**Input**: Add a slow-down pacing mode to Claude Code: work 5 minutes, pause 4 minutes, repeat — configurable, must never interrupt/corrupt the session and must produce no noise for the AI model

---

## Clarifications

### Session 2026-09-18

- Q: When the work timer expires mid-task, does the pause start only after the current task finishes, or at exactly 5 minutes regardless? → A: Only after the current task finishes; long tasks cause work-phase overrun rather than interruption.
- Q: Does the cycle timer keep running while the session is idle, or does idle time suspend it? → A: The timer runs continuously while pacing is enabled, regardless of whether the agent is idle or active.
- Q: When the user sends a prompt during a pause, does the agent respond immediately or wait for the pause to complete? → A: Immediately — user input breaks the pause short and starts a new work phase.
- Q: Where does pacing configuration persist, and what is the default enabled state? → A: Global defaults with per-project overrides (project values win); pacing is disabled by default and must be enabled per session — session-level enable/configure state never carries into the next session.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Deterministic Work/Pause Cycle (Priority: P1)

A user running long, autonomous Claude Code sessions (e.g., overnight refactors, bulk migrations, extended research) notices the agent charging ahead faster than they can review. They enable slow-down pacing with the default schedule. From that point on, the agent works normally for 5 minutes, then the session enters a 4-minute pause, and this cycle repeats indefinitely. The user's hands-free task still completes — just at a deliberate, reviewable pace — and the session remains fully usable before, during, and after every pause.

**Why this priority**: This is the entire reason the feature exists. Without a correct, safe, repeating cycle, nothing else in the feature has value.

**Independent Test**: Enable pacing with the default schedule, run a session for at least one full cycle, and observe that work proceeds uninterrupted for the work duration, a pause of the pause duration occurs, and the cycle repeats. A second cycle confirms repetition.

**Acceptance Scenarios**:

1. **Given** pacing is enabled with default settings, **When** the work duration elapses while the agent is active, **Then** the session enters a pause lasting exactly the configured pause duration (4 minutes by default), during which the session is not terminated, restarted, or altered in any way.
2. **Given** a pause has elapsed, **When** the next cycle begins, **Then** the agent is able to continue working with no loss of context, no corrupted transcript, and no restart.
3. **Given** pacing is enabled, **When** multiple consecutive cycles elapse (3+ cycles), **Then** each cycle follows the same configured work/pause durations, and cycle boundaries are predictable within normal scheduling tolerance.
4. **Given** the user is actively typing or waiting on a prompt, **When** a cycle boundary occurs, **Then** no user input is lost, swallowed, or delayed beyond the pause itself, and the session accepts the user's next interaction normally.

---

### User Story 2 - Model Silence During Pauses (Priority: P2)

A user with a long-running session wants the pauses to affect only the human's review cadence — never the AI model's context. While a pause is in effect, the AI model must perceive nothing: no injected messages, no extra turns, no tool output, no tokens, no "system reminders" about pacing. When work resumes after a pause, the model continues exactly where it left off, as if no pause had occurred.

**Why this priority**: A pacing mechanism that pollutes the model's context would degrade output quality and inflate token usage — a correctness requirement tightly coupled to the core cycle. It ranks just below the cycle itself because the cycle defines the feature and silence defines its safety.

**Independent Test**: Enable pacing, let a pause complete, and inspect the session's conversation as seen by the AI model (transcript/context contents) to confirm zero pacing-related entries appeared and the model's next turn continues seamlessly.

**Acceptance Scenarios**:

1. **Given** pacing is enabled and a pause begins, **When** the pause runs its full duration, **Then** no message, reminder, token, tool result, or other content attributable to pacing is added to the AI model's conversation.
2. **Given** a pause has completed and work resumes, **When** the model produces its next output, **Then** the output shows no awareness of or reaction to the pause (no apologizing for a gap, no commenting on elapsed time attributable to pacing).
3. **Given** any number of pauses have occurred in a session, **When** the user inspects the session's context, **Then** pacing has contributed zero tokens to it.

---

### User Story 3 - Configuration Without Restart (Priority: P3)

A user wants to tune the pacing to their needs — different work and pause durations, or turning the mode entirely off — while a session is already running, without restarting it or endangering the session. All pacing behavior (durations, on/off state) is driven by configuration that the user can change and the plugin honors on the next cycle boundary, never mid-pause in a way that could disrupt the session.

**Why this priority**: Essential for daily use, but the feature delivers value with defaults alone; configuration can follow the working core cycle.

**Independent Test**: With pacing enabled, change the work and pause durations and disable the mode, then observe that within at most one subsequent cycle boundary the behavior matches the new configuration — and that the running session was never interrupted by the change.

**Acceptance Scenarios**:

1. **Given** pacing is enabled, **When** the user changes the work or pause duration in the supported settings, **Then** the next cycle after the change uses the new durations, without any session restart or interruption.
2. **Given** pacing is enabled, **When** the user disables pacing, **Then** pauses stop occurring as soon as safely possible (at latest, the current cycle's pause is allowed to complete normally) and the session behaves as if pacing were never enabled.
3. **Given** pacing is disabled, **When** the user enables it, **Then** a new cycle begins from the work phase without restart.
4. **Given** a pause is currently in progress, **When** the user disables pacing or changes durations, **Then** the in-progress pause either completes normally or is cut short cleanly, the session is never left in a broken or hung state, and no cycle corruption occurs.

---

### User Story 4 - Visible Pacing State for the Human (Priority: P4)

A user watching a paced session wants to always know whether pacing is active and where in the cycle the session currently is (working, how much work time remains / paused, how much pause time remains). The state is visible to the human through the session's normal display surface, and it consumes no model-visible context.

**Why this priority**: Improves trust and usability but is not required for the pacing to function correctly.

**Independent Test**: Enable pacing and observe the session's visible state at multiple points within a cycle; confirm it correctly reflects the current phase and time remaining, and confirm this state contributes nothing to the model's conversation.

**Acceptance Scenarios**:

1. **Given** pacing is enabled, **When** the user looks at the session's visible state, **Then** they can tell whether pacing is active, which phase (work/pause) the session is in, and how much time remains in that phase.
2. **Given** pacing is disabled, **When** the user looks at the session's visible state, **Then** there is no indication of pacing activity.
3. **Given** the pacing state is displayed, **When** the model's conversation is inspected, **Then** the state display has contributed nothing to it (consistent with User Story 2).

### Edge Cases

- **What happens when configuration values are invalid (zero, negative, non-numeric, or missing)?** The plugin MUST treat invalid configuration as "no pacing" (disabled behavior) rather than attempting a broken or infinite pause, and MUST surface the misconfiguration to the human only (never to the model).
- **What happens if the pause mechanism cannot run safely in the current environment** (unsupported platform, timeout limits, or a required permission is denied)? The plugin MUST skip pausing for that cycle and continue normal operation, rather than risking the session.
- **What happens when the session is idle or the user is interacting at a cycle boundary?** Pausing MUST NOT disrupt user interaction; any pending user input survives and is handled normally.
- **What happens if pacing is enabled mid-session, partway through what would have been a cycle?** A fresh cycle begins at the work phase; no attempt is made to backfill a partial cycle.
- **What happens if the user sends a message during a pause?** The user's input is not lost or swallowed; it breaks the pause short (FR-010a) — the agent responds immediately and a new work phase begins.
- **What happens across multiple rapid enable/disable toggles?** The plugin MUST not leave orphaned timers or inconsistent state; after toggling, pacing state must be internally consistent within one cycle boundary.
- **What happens when the session ends while a pause is pending or in progress?** Session termination takes precedence; pacing MUST never delay or block a session shutdown the user initiated.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a slow-down pacing mode that alternates between a work phase and a pause phase, repeating continuously while enabled.
- **FR-002**: The default schedule MUST be 5 minutes of work followed by 4 minutes of pause.
- **FR-002a**: A pause MUST NOT begin while the agent is in the middle of a task; when the work timer expires mid-task, the work phase overruns and the pause begins only after the agent's current task completes. The pause is therefore never the cause of interrupting in-flight work.
- **FR-003**: During a pause, the running session MUST NOT be terminated, restarted, killed, signaled, or modified; the pause MUST use only safe waiting mechanisms that leave the session process and its state untouched.
- **FR-004**: During a pause, the system MUST add zero content to the AI model's conversation: no messages, reminders, tokens, tool results, turns, or any other model-visible output.
- **FR-005**: Work and pause durations MUST be configurable through supported configuration, with the defaults in FR-002 applying when not configured.
- **FR-006**: Pacing MUST be able to be enabled, disabled, and reconfigured at any time without restarting the session; changes MUST take effect no later than the next cycle boundary.
- **FR-007**: Configuration validation MUST reject or safely neutralize invalid values (non-positive, non-numeric, or missing critical values) by treating pacing as inactive rather than risking an unsafe pause; the failure MUST be visible to the human only.
- **FR-008**: If a pause cannot be executed safely in the current environment (platform limitation, timeout constraint, or denied permission), the system MUST skip the pause for that cycle and continue normal operation without erroring the session.
- **FR-009**: The system MUST present pacing state (active/inactive, current phase, time remaining in phase) to the human through a user-visible display surface; this presentation MUST itself be model-silent.
- **FR-010**: User input given during a pause MUST NOT be lost, swallowed, or corrupted.
- **FR-010a**: User input sent during a pause MUST break the pause short: the agent responds immediately and a new work phase begins. The user's intent always takes precedence over the pause timer.
- **FR-011**: Cycles MUST be deterministic and reproducible: with fixed configuration, the sequence and duration of phases MUST be identical across runs, allowing only normal scheduling tolerance. While pacing is enabled, the cycle timer MUST run continuously (including while the session is idle awaiting user input), not only while the agent is actively working.
- **FR-012**: Session shutdown or exit MUST always take precedence over pacing; pacing MUST never delay, block, or interfere with a user-initiated session end.
- **FR-013**: Rapid enable/disable/reconfigure toggles MUST converge to a consistent pacing state within one cycle boundary, with no orphaned timers or inconsistent state.
- **FR-014**: Pacing configuration MUST support two persistence layers: user-global defaults and per-project overrides, where a per-project value always wins over the global value for the same setting.
- **FR-015**: Pacing MUST be disabled by default: every new session starts with pacing off, regardless of any stored configuration. Enabling pacing is a per-session action, and per-session state (enabled/disabled, current phase, in-session reconfigurations) MUST NOT persist into subsequent sessions — each session's default is disabled.

### Assumptions

- Pacing applies to the human/agent interaction cadence of a single session; coordinating pacing across multiple simultaneous sessions is out of scope for v1.
- "No noise for the AI model" is interpreted as: the model's conversation context gains zero pacing-attributable content; the human's screen may still show pacing status.
- Default 5-minute work / 4-minute pause values are a deliberate slowdown cadence chosen by the requester; any reasonable defaults are acceptable as long as they match FR-002.
- The plugin runs on standard desktop platforms Claude Code supports (Linux, macOS, Windows); any platform where safe waiting is impossible MUST be explicitly detected and pacing skipped (FR-008) rather than failing.
- Configuration is expected to live in plugin- or settings-scoped configuration files (per project constitution), in two layers: user-global defaults with per-project overrides (FR-014); the specific file locations are a planning decision.
- Auto-enabling pacing on all sessions is out of scope: v1 pacing is opt-in per session (every session starts disabled, FR-015), never forced on and never auto-restored from a previous session.

### Key Entities

- **Pacing Configuration**: The persisted, user-controlled values defining pacing behavior — work duration and pause duration, stored as user-global defaults with per-project overrides (project values win). Note that the enabled/disabled state is NOT part of persisted configuration: pacing is always off when a session starts (see Cycle State). Invalid values are neutralized per FR-007.
- **Cycle State**: The plugin's current knowledge of pacing at any moment — whether pacing is active (starts as disabled in every session), the current phase (work or pause), when that phase started, and how much time remains. This state is per-session only and never persists into a later session; none of it is exposed to the model.
- **Cycle**: One complete work phase followed by one complete pause phase, repeating while pacing is enabled.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With default configuration, over a 27-minute continuously running session, exactly 3 work phases (5 minutes each) and 3 pause phases (4 minutes each) occur, matching the 5/4 cadence within normal scheduling tolerance.
- **SC-002**: Across a full session with 10 or more completed pauses, the AI model's conversation contains zero pacing-attributable tokens (verified by inspecting the model-visible context).
- **SC-003**: Every pause in a test session of 10+ cycles completes with the session still alive, responsive, and continuing its task without restart, corruption, or data loss — a 100% session-survival rate.
- **SC-004**: After a user changes work/pause durations or toggles pacing on/off mid-session, the new behavior is observable within at most one subsequent cycle boundary, with no session restart required.
- **SC-005**: Invalid configuration (e.g., pause duration of 0 or negative) results in pacing being treated as inactive with a human-visible notice, and zero occurrences of a hung, broken, or erroring session across all tested invalid configurations.
- **SC-006**: Users can tell at a glance whether pacing is active and how much time remains in the current phase at any point during a paced session.
- **SC-007**: Every newly started session begins with pacing disabled (verified across 10+ fresh sessions, including ones whose project/global configuration exists), zero instances of pacing being active or of session-level state from a prior session carrying over.

---

## Review & Acceptance Checklist
*GATE: Automated checks run during main() execution*

### Content Quality
- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

### Requirement Completeness
- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

### Feature Readiness
- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification
