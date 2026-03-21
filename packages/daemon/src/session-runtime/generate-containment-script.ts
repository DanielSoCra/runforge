// src/session-runtime/generate-containment-script.ts
//
// Generates a self-contained Node.js script that enforces containment policy
// as a Claude Code PreToolUse hook. The script reads tool call JSON from stdin,
// applies path blocking, read/write classification, and command blocking,
// then exits 0 (allow) or 2 (block, reason on stderr).
import { WRITE_TOOLS, type ContainmentPolicy } from './containment-hooks.js';

/**
 * Validates that all patterns in a policy are supported by the generated hook script.
 * Supported patterns: exact strings (e.g. 'CLAUDE.md') and trailing /** globs (e.g. '.specify/**').
 * Throws if an unsupported pattern is found.
 */
export function validatePolicyPatterns(policy: ContainmentPolicy): void {
  const allPatterns = [...policy.blockedPaths, ...policy.readOnlyPaths];
  for (const pattern of allPatterns) {
    const hasWildcard = pattern.includes('*') || pattern.includes('?');
    const isTrailingGlob = pattern.endsWith('/**');
    if (hasWildcard && !isTrailingGlob) {
      throw new Error(
        `Unsupported containment pattern: "${pattern}". Only exact strings and trailing /** globs are supported.`,
      );
    }
  }
}

export function generateContainmentScript(policy: ContainmentPolicy): string {
  validatePolicyPatterns(policy);
  const policyJson = JSON.stringify(policy);
  const writeToolsJson = JSON.stringify(WRITE_TOOLS);
  return `#!/usr/bin/env node
'use strict';

const policy = ${policyJson};

function globMatch(path, pattern) {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(prefix + '/');
  }
  return path === pattern;
}

const WRITE_TOOLS = ${writeToolsJson};

function extractPaths(input) {
  const paths = [];
  for (const key of ['file_path', 'path', 'filePath', 'target']) {
    if (typeof input[key] === 'string') paths.push(input[key]);
  }
  return paths;
}

function normalizePath(p) {
  // Inline path normalization: resolve . and .. segments, collapse separators
  const parts = p.split('/');
  const result = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '.' || parts[i] === '') continue;
    if (parts[i] === '..' && result.length > 0 && result[result.length - 1] !== '..') {
      result.pop();
    } else {
      result.push(parts[i]);
    }
  }
  return result.join('/');
}

function extractCommandPaths(command) {
  const tokens = command.split(/[|;&\\s]+/).filter(Boolean);
  const paths = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('-') || token.startsWith('$') || token.includes('=')) continue;
    if (token.includes('/') || token.includes('.')) {
      const cleaned = token.replace(/^[<>]+/, '').replace(/^["']|["']$/g, '');
      if (cleaned) paths.push(normalizePath(cleaned));
    }
  }
  return paths;
}

const WRITE_INDICATOR_RE = /[>]|\\btee\\b|\\bcp\\b|\\bmv\\b|\\bsed\\s+-i\\b|\\bdd\\b/;

function checkContainment(toolName, toolInput) {
  const paths = extractPaths(toolInput);

  for (const p of paths) {
    for (const pattern of policy.blockedPaths) {
      if (globMatch(p, pattern)) {
        return { allowed: false, reason: 'Blocked path: ' + p + ' matches ' + pattern };
      }
    }
  }

  if (WRITE_TOOLS.includes(toolName)) {
    for (const p of paths) {
      for (const pattern of policy.readOnlyPaths) {
        if (globMatch(p, pattern)) {
          return { allowed: false, reason: 'Write blocked on read-only path: ' + p };
        }
      }
    }
  }

  if (toolName === 'Bash' || toolName === 'shell') {
    const command = String(toolInput.command || toolInput.cmd || '');
    for (const blocked of policy.blockedCommands) {
      if (command.includes(blocked)) {
        return { allowed: false, reason: 'Blocked command pattern: ' + blocked };
      }
    }

    const cmdPaths = extractCommandPaths(command);
    const isWrite = WRITE_INDICATOR_RE.test(command);
    for (let i = 0; i < cmdPaths.length; i++) {
      for (const pattern of policy.blockedPaths) {
        if (globMatch(cmdPaths[i], pattern)) {
          return { allowed: false, reason: 'Blocked path in command: ' + cmdPaths[i] + ' matches ' + pattern };
        }
      }
      if (isWrite) {
        for (const pattern of policy.readOnlyPaths) {
          if (globMatch(cmdPaths[i], pattern)) {
            return { allowed: false, reason: 'Write blocked on read-only path in command: ' + cmdPaths[i] };
          }
        }
      }
    }
  }

  return { allowed: true };
}

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const result = checkContainment(input.tool_name, input.tool_input || {});
    if (!result.allowed) {
      process.stderr.write(result.reason + '\\n');
      process.exit(2);
    }
    process.exit(0);
  } catch (e) {
    process.stderr.write('Containment hook: failed to parse input: ' + e.message + '\\n');
    process.exit(2);
  }
});
`;
}
