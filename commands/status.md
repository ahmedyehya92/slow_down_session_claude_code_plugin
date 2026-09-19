---
description: Show slow-down pacing status for this session (read-only)
disable-model-invocation: true
allowed-tools: Bash(node:*)
---
node --input-type=module -e "const DATA_DIR = '${CLAUDE_PLUGIN_DATA}'; import { projectStatus, formatStatusReport } from '${CLAUDE_PLUGIN_ROOT}/scripts/pacing.mjs'; import { resolveConfig } from '${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs'; const sessionId = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID; if (typeof sessionId !== 'string' || sessionId.length === 0 || !/^[\w.-]+$/.test(sessionId)) { console.error('Slow-down pacing: could not determine the current session id — cannot report status.'); process.exitCode = 1; } else if (typeof DATA_DIR !== 'string' || DATA_DIR.length === 0) { console.error('Slow-down pacing: could not determine the plugin data directory — cannot report status.'); process.exitCode = 1; } else { const config = resolveConfig(); const status = projectStatus(sessionId, config, Date.now(), { CLAUDE_PLUGIN_DATA: DATA_DIR }); console.log(formatStatusReport(status)); }"
