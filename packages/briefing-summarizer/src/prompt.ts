/**
 * Prompt builder and tool schema for the Claude Haiku summarizer call.
 *
 * Uses tool_use with tool_choice to guarantee the model returns structured
 * output matching the Briefing schema.
 */

import type { SignalResult } from './signals.js';

// ---------------------------------------------------------------------------
// Briefing JSON Schema (used as tool input_schema)
// ---------------------------------------------------------------------------

export const briefingSchema = {
  type: 'object' as const,
  required: ['status_line', 'changes', 'attention', 'forecast'],
  properties: {
    status_line: {
      type: 'string' as const,
      description:
        'A single sentence summarizing the overall system state (e.g. "3 runs active, 1 awaiting review, pipeline healthy").',
    },
    changes: {
      type: 'array' as const,
      description: 'Array of notable changes since the last briefing.',
      items: {
        type: 'object' as const,
        required: ['summary'],
        properties: {
          summary: {
            type: 'string' as const,
            description: 'Human-readable description of what changed.',
          },
          links: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              required: ['label', 'url'],
              properties: {
                label: { type: 'string' as const },
                url: { type: 'string' as const },
              },
            },
          },
        },
      },
    },
    attention: {
      type: 'array' as const,
      description: 'Items requiring human attention, ordered by urgency.',
      items: {
        type: 'object' as const,
        required: ['issueNumber', 'reason'],
        properties: {
          issueNumber: {
            type: 'number' as const,
            description: 'The GitHub issue number.',
          },
          reason: {
            type: 'string' as const,
            description: 'Why this needs attention (blocked, review, failure).',
          },
          waitDuration: {
            type: 'string' as const,
            description: 'How long this has been waiting (e.g. "2h").',
          },
          actionLinks: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              required: ['label', 'url'],
              properties: {
                label: { type: 'string' as const },
                url: { type: 'string' as const },
              },
            },
          },
        },
      },
    },
    forecast: {
      type: 'string' as const,
      description:
        'A short forward-looking statement about what is likely to happen next.',
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const briefingTool = {
  name: 'produce_briefing' as const,
  description:
    'Produce a structured briefing summarizing the current state of the auto-claude system.',
  input_schema: briefingSchema,
};

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export interface PreviousBriefing {
  status_line: string;
  changes: unknown[];
  attention: unknown[];
  forecast: string;
  generated_at: string;
}

export function buildSignalPrompt(
  signals: SignalResult,
  previousBriefing?: PreviousBriefing | null,
): string {
  const sections: string[] = [];

  sections.push('You are a system summarizer for auto-claude, an autonomous coding pipeline.');
  sections.push('Analyze the following signals and produce a structured briefing.');
  sections.push('');

  // --- Previous briefing context ---
  if (previousBriefing) {
    sections.push('## Previous Briefing');
    sections.push(`Generated at: ${previousBriefing.generated_at}`);
    sections.push(`Status: ${previousBriefing.status_line}`);
    sections.push(`Forecast: ${previousBriefing.forecast}`);
    sections.push('');
  }

  // --- Runs ---
  sections.push('## Runs (since last briefing)');
  if (signals.runs.length === 0) {
    sections.push('No runs updated since last briefing.');
  } else {
    sections.push(`${signals.runs.length} run(s) updated:`);
    sections.push('```json');
    sections.push(JSON.stringify(signals.runs, null, 2));
    sections.push('```');
  }
  sections.push('');

  // --- Daemon status ---
  sections.push('## Daemon Status');
  if (signals.daemonStatus) {
    sections.push('```json');
    sections.push(JSON.stringify(signals.daemonStatus, null, 2));
    sections.push('```');
  } else {
    sections.push('Daemon status unavailable.');
  }
  sections.push('');

  // --- Git log ---
  sections.push('## Git Log (recent commits)');
  if (signals.gitLog.length === 0) {
    sections.push('No commits since last briefing.');
  } else {
    sections.push(`${signals.gitLog.length} commit(s):`);
    for (const line of signals.gitLog) {
      sections.push(`- ${line}`);
    }
  }
  sections.push('');

  // --- Heartbeat ---
  sections.push('## Heartbeat');
  if (signals.heartbeatAt) {
    sections.push(`Daemon heartbeat at: ${signals.heartbeatAt}`);
  } else {
    sections.push('No heartbeat — daemon may be unreachable.');
  }
  sections.push('');

  // --- Gaps ---
  if (signals.gaps.length > 0) {
    sections.push('## Signal Gaps');
    sections.push('The following signals could not be collected:');
    for (const gap of signals.gaps) {
      sections.push(`- ${gap}`);
    }
    sections.push('');
    sections.push('Produce a briefing with the available data and note any gaps in the forecast.');
  }

  sections.push('');
  sections.push('## Instructions');
  sections.push('- status_line: one sentence summarizing the overall system state.');
  sections.push('- changes: list of notable changes since the last briefing. Include links to issues/PRs/commits when available.');
  sections.push('- attention: items requiring human attention, ordered by urgency (blocked > review > failure). Include issue numbers and action links.');
  sections.push('- forecast: a short forward-looking statement about what is likely to happen next.');

  return sections.join('\n');
}
