---
description: Show slow-down pacing status for this session (read-only)
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
node --input-type=module -e "import { projectStatus, formatStatusReport } from '${CLAUDE_PLUGIN_ROOT}/scripts/pacing.mjs'; import { resolveConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs'; const sessionId = process.env.CLAUDE_CODE_SESSION_ID || '${CLAUDE_SESSION_ID}'; if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.includes('$') || sessionId.includes('{') || !/^[\w.-]+$/.test(sessionId)) { console.error('Slow-down pacing: could not determine the current session id — cannot report status.'); process.exit(1); } const config = resolveConfig(); const status = projectStatus(sessionId, config, Date.now()); console.log(formatStatusReport(status));"
