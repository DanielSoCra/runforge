import { createToolRegistry, type BlastRadius, type JsonSchema, type ToolEntry, type ToolRegistry } from './registry.js';

interface DefaultToolSpec {
  name: string;
  description: string;
  subsystem: string;
  blastRadius: BlastRadius;
  governingSpecId: string | null;
  argsSchema: JsonSchema;
}

const EMPTY_OBJECT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const ISSUE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['issue'],
  properties: {
    issue: { type: 'number' },
  },
};

const PATH_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string' },
  },
};

const QUERY_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string' },
  },
};

const DEFAULT_TOOL_SPECS: DefaultToolSpec[] = [
  {
    name: 'ac_run',
    description: 'Start an runforge run for one issue',
    subsystem: 'runforge',
    blastRadius: 'medium',
    governingSpecId: 'FUNC-AC-CONTROL-PLANE',
    argsSchema: ISSUE_SCHEMA,
  },
  {
    name: 'ac_status',
    description: 'Read the runforge daemon status',
    subsystem: 'runforge',
    blastRadius: 'safe',
    governingSpecId: 'FUNC-AC-CONTROL-PLANE',
    argsSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    name: 'ac_pause',
    description: 'Pause the runforge daemon',
    subsystem: 'runforge',
    blastRadius: 'medium',
    governingSpecId: 'FUNC-AC-CONTROL-PLANE',
    argsSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    name: 'ac_unstuck',
    description: 'Retry one stuck runforge issue',
    subsystem: 'runforge',
    blastRadius: 'medium',
    governingSpecId: 'FUNC-AC-CONTROL-PLANE',
    argsSchema: ISSUE_SCHEMA,
  },
  {
    name: 'ac_merge_to_main',
    description: 'Merge an approved runforge change to main',
    subsystem: 'runforge',
    blastRadius: 'high',
    governingSpecId: 'FUNC-AC-CONTROL-PLANE',
    argsSchema: ISSUE_SCHEMA,
  },
  {
    name: 'sb_read',
    description: 'Read an allowed knowledge-base note',
    subsystem: 'knowledge-base',
    blastRadius: 'safe',
    governingSpecId: null,
    argsSchema: PATH_SCHEMA,
  },
  {
    name: 'sb_search',
    description: 'Search the knowledge vault',
    subsystem: 'knowledge-base',
    blastRadius: 'safe',
    governingSpecId: null,
    argsSchema: QUERY_SCHEMA,
  },
  {
    name: 'sb_append_inbox',
    description: 'Append a note to the knowledge-base inbox',
    subsystem: 'knowledge-base',
    blastRadius: 'medium',
    governingSpecId: null,
    argsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug', 'body'],
      properties: {
        slug: { type: 'string' },
        body: { type: 'string' },
      },
    },
  },
  {
    name: 'sb_write_decision',
    description: 'Write a project decision note',
    subsystem: 'knowledge-base',
    blastRadius: 'medium',
    governingSpecId: null,
    argsSchema: PATH_SCHEMA,
  },
  {
    name: 'sb_write_client',
    description: 'Write a client-folder note after confirmation',
    subsystem: 'knowledge-base',
    blastRadius: 'high',
    governingSpecId: null,
    argsSchema: PATH_SCHEMA,
  },
  {
    name: 'gh_search',
    description: 'Search GitHub read-only',
    subsystem: 'github',
    blastRadius: 'safe',
    governingSpecId: null,
    argsSchema: QUERY_SCHEMA,
  },
  {
    name: 'gh_comment',
    description: 'Comment on a GitHub issue or pull request',
    subsystem: 'github',
    blastRadius: 'medium',
    governingSpecId: null,
    argsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['repo', 'number', 'body'],
      properties: {
        repo: { type: 'string' },
        number: { type: 'number' },
        body: { type: 'string' },
      },
    },
  },
  {
    name: 'cal_read',
    description: 'Read calendar events',
    subsystem: 'calendar',
    blastRadius: 'safe',
    governingSpecId: null,
    argsSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    name: 'mail_draft',
    description: 'Create an email draft',
    subsystem: 'email',
    blastRadius: 'medium',
    governingSpecId: null,
    argsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['to', 'subject', 'body'],
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
    },
  },
  {
    name: 'mail_send',
    description: 'Send an external email after confirmation',
    subsystem: 'email',
    blastRadius: 'high',
    governingSpecId: null,
    argsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['draftId'],
      properties: {
        draftId: { type: 'string' },
      },
    },
  },
  {
    name: 'slack_send_dm',
    description: 'Send a Slack DM to the operator',
    subsystem: 'slack',
    blastRadius: 'safe',
    governingSpecId: null,
    argsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string' },
      },
    },
  },
  {
    name: 'slack_send_channel',
    description: 'Post to a Slack channel after confirmation',
    subsystem: 'slack',
    blastRadius: 'high',
    governingSpecId: null,
    argsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['channel', 'text'],
      properties: {
        channel: { type: 'string' },
        text: { type: 'string' },
      },
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch and summarize a web page',
    subsystem: 'web',
    blastRadius: 'safe',
    governingSpecId: null,
    argsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string' },
      },
    },
  },
  {
    name: 'obs_recent_activity',
    description: 'Read recent observed activity',
    subsystem: 'observer',
    blastRadius: 'safe',
    governingSpecId: null,
    argsSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    name: 'obs_daemon_state',
    description: 'Read cached daemon observer state',
    subsystem: 'observer',
    blastRadius: 'safe',
    governingSpecId: null,
    argsSchema: EMPTY_OBJECT_SCHEMA,
  },
];

export function createDefaultToolEntries(
  handlers: Partial<Record<string, ToolEntry['handler']>> = {},
): ToolEntry[] {
  return DEFAULT_TOOL_SPECS.map((spec) => ({
    ...spec,
    audit: 'always',
    cacheable: spec.blastRadius === 'safe',
    status: 'experimental',
    handler: handlers[spec.name] ?? notConfiguredHandler(spec.name),
  }));
}

export function createDefaultToolRegistry(
  handlers: Partial<Record<string, ToolEntry['handler']>> = {},
): ToolRegistry {
  return createToolRegistry(createDefaultToolEntries(handlers));
}

function notConfiguredHandler(name: string): ToolEntry['handler'] {
  return async () => {
    throw new Error(`handler not configured for ${name}`);
  };
}
