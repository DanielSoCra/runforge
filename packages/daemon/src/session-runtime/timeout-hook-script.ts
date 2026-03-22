// src/session-runtime/timeout-hook-script.ts
//
// Generates a self-contained Node.js script that acts as a Claude Code PreToolUse
// hook for timeout warnings. Reads SESSION_START_TIME and SESSION_TIMEOUT_MS from
// env vars, warns once when the session approaches its time limit.

import { TIMEOUT_WARNING_MESSAGE } from './timeout-hook.js';

/**
 * Generates a Node.js script for use as a CLI PreToolUse hook.
 * The script reads SESSION_START_TIME and SESSION_TIMEOUT_MS from the environment,
 * uses a marker file to ensure the warning fires only once per session.
 */
export function generateTimeoutHookScript(): string {
  const warningJson = JSON.stringify(TIMEOUT_WARNING_MESSAGE);
  return `#!/usr/bin/env node
'use strict';

const startTime = parseInt(process.env.SESSION_START_TIME || '0', 10);
const timeoutMs = parseInt(process.env.SESSION_TIMEOUT_MS || '600000', 10);
const warningBufferMs = 120000; // 2 minutes

if (!startTime) {
  // No start time set — allow the tool call
  process.exit(0);
}

const elapsed = Date.now() - startTime;
const threshold = timeoutMs - warningBufferMs;

if (elapsed <= threshold) {
  process.exit(0);
}

// One-shot: use a marker file to ensure we only warn once
const fs = require('fs');
const path = require('path');
const markerPath = path.join(
  require('os').tmpdir(),
  'timeout-warned-' + startTime + '.marker'
);

if (fs.existsSync(markerPath)) {
  // Already warned — allow subsequent tool calls
  process.exit(0);
}

// First time past threshold — block this tool call with warning
fs.writeFileSync(markerPath, '1');
process.stderr.write(${warningJson} + '\\n');
process.exit(2);
`;
}
