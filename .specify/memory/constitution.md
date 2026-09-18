<!--
=== SYNC IMPACT REPORT ===
Version change: (none — first adoption) → 1.0.0
Modified principles: (none — initial constitution)
Added sections: Core Principles (5), Constraints, Development Workflow, Governance
Removed sections: (none)
Follow-up TODOs: none — all placeholders resolved
Deferred non-governance intent: build the slow-down-session plugin itself
  (suggested follow-up: /speckit-specify)
=== END REPORT ===
-->

# Claude Code Slow-Down Session Plugin Constitution

## Core Principles

### I. Session Integrity First (NON-NEGOTIABLE)

The plugin MUST NOT interrupt, corrupt, or end a running Claude Code
session. Pauses MUST occur through mechanisms that Claude Code supports for
waiting (e.g. hooks that gate continuation or a shell-level wait the harness
is designed for) — never by killing processes, sending signals, tampering
with session/transcript files, or forcing the session into error states. If
a pause cannot be performed safely in the current context, the plugin MUST
skip the pause rather than risk session damage. Rationale: the plugin's sole
purpose is pacing; any mechanism that can break a session defeats it.

### II. Model Silence (NON-NEGOTIABLE)

Pauses MUST produce zero noise for the AI model. The pause mechanism MUST
NOT inject new turns, messages, tool outputs, or tokens into the
conversation that the model would see and react to. Any prompt returned to
the harness during a pause MUST be a no-op signal (e.g. a minimal, explicit
continue token), never commentary, status text, or instructions that could
redirect the model's behavior. Rationale: model-visible noise wastes tokens
and can derail the agent's task; pacing must be invisible to the model.

### III. Deterministic Pacing

The plugin operates on an explicit, time-based work/pause cycle: work N
minutes, then pause M minutes, repeating. Both values MUST be user-
configurable with sensible defaults (example cycle: 5 min work / 4 min
pause). Timing behavior MUST be predictable and reproducible — no hidden
randomization, no undocumented state that alters the cycle. Rationale:
users adopt pacing to enforce deliberate slowness; unpredictable timing
undermines the guarantee.

### IV. Human Transparency and Control

The human user MUST be able to observe and control the plugin. The current
state (working or paused, with remaining time) MUST be visible through
Claude Code's supported channels (e.g. status line, hook output the user
sees). The user MUST be able to enable, disable, and reconfigure the pacing
without restarting or risking the session. Rationale: pacing affects the
human's experience directly; opaque or uncontrolled slowdowns are
unacceptable.

### V. Simplicity and Minimal Footprint

Start simple; YAGNI principles apply. The plugin MUST be implemented with
the fewest moving parts that satisfy Principles I–IV (prefer Claude Code
native extension points — hooks, skills, commands — over external daemons
or services). Complexity MUST be justified in the spec; every added feature
must be traceable to a stated user need. Rationale: more moving parts mean
more ways to violate session integrity or model silence.

## Constraints

- The plugin MUST operate entirely within Claude Code's officially supported
  extension surfaces (hooks, skills, slash commands, settings files); it
  MUST NOT require patching, forking, or monkey-patching Claude Code itself.
- Configuration MUST live in plugin- or settings-scoped config (e.g. a
  settings file), never hard-coded; all timing values, enable/disable
  state, and the continue token MUST be configurable.
- The plugin MUST behave correctly on all platforms Claude Code runs on
  (Linux, macOS, Windows) or MUST declare and enforce platform limitations
  explicitly rather than failing silently.
- Long waits MUST use mechanisms that respect Claude Code's command
  timeouts and permissions model; the plugin MUST degrade gracefully
  (skip pause, log to the user) when a timeout or permission constraint
  prevents a safe wait.

## Development Workflow

- All features follow Spec Kit: `/speckit-specify` → `/speckit-clarify` →
  `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`.
- Test-first is REQUIRED for pacing logic: the work/pause cycle, timeout
  handling, and no-op continue signaling MUST have executable tests
  demonstrating (a) the cycle fires at the configured intervals and
  (b) no model-visible output is produced during pauses — before
  implementation.
- Every change MUST be reviewed against Principles I and II explicitly;
  a change that risks session interruption or model-visible noise MUST be
  rejected regardless of other merit.

## Governance

This constitution supersedes all other project practices and documents.
Amendments MUST: document the change, update this file with a semantic
version bump (MAJOR for removal/redefinition of principles, MINOR for new
principles or materially expanded guidance, PATCH for clarifications), and
carry a migration note if behavior changes. All PRs and reviews MUST verify
compliance with this constitution; complexity that cannot be justified
against Principle V MUST be rejected. Use the project's plan and spec
documents for runtime development guidance; this file governs principles,
not implementation detail.

**Version**: 1.0.0 | **Ratified**: 2026-09-18 | **Last Amended**: 2026-09-18
