import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface ConciergeConfig {
  slackBotToken: string;
  slackSigningSecret: string;
  operatorSlackUserId: string;
  anthropicApiKey: string;
  modelId: string;
  tunnelHostname: string;
  boardHostname: string;
  vaultPath: string;
  watchedRepos: string[];
  operatorEmail: string;
  autoClaudeBaseUrl: string;
}

export interface LoadConfigOptions {
  configPath?: string;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => Promise<string>;
}

const DEFAULT_CONFIG_PATH = join(homedir(), 'Library/Application Support/concierge/config.json');

export async function loadConciergeConfig(options: LoadConfigOptions = {}): Promise<ConciergeConfig> {
  const env = options.env ?? process.env;
  const path = env.CONCIERGE_CONFIG_PATH ?? options.configPath ?? DEFAULT_CONFIG_PATH;
  const read = options.readFile ?? ((filePath: string) => readFile(filePath, 'utf-8'));
  const parsed = JSON.parse(await read(path)) as Record<string, unknown>;
  const config = {
    slackBotToken: env.CONCIERGE_SLACK_BOT_TOKEN ?? readString(parsed, 'slackBotToken'),
    slackSigningSecret: env.CONCIERGE_SLACK_SIGNING_SECRET ?? readString(parsed, 'slackSigningSecret'),
    operatorSlackUserId: env.CONCIERGE_OPERATOR_SLACK_USER_ID ?? readString(parsed, 'operatorSlackUserId'),
    anthropicApiKey: env.CONCIERGE_ANTHROPIC_API_KEY ?? readString(parsed, 'anthropicApiKey'),
    modelId: env.CONCIERGE_MODEL_ID ?? readString(parsed, 'modelId'),
    tunnelHostname: env.CONCIERGE_TUNNEL_HOSTNAME ?? readString(parsed, 'tunnelHostname'),
    boardHostname: env.CONCIERGE_BOARD_HOSTNAME ?? readString(parsed, 'boardHostname'),
    vaultPath: env.CONCIERGE_VAULT_PATH ?? readString(parsed, 'vaultPath'),
    watchedRepos: readStringArray(parsed, 'watchedRepos'),
    operatorEmail: env.CONCIERGE_OPERATOR_EMAIL ?? readString(parsed, 'operatorEmail'),
    autoClaudeBaseUrl: env.CONCIERGE_AUTO_CLAUDE_BASE_URL ?? readOptionalString(parsed, 'autoClaudeBaseUrl') ?? 'http://127.0.0.1:3847',
  };
  return config;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key} must be a string array`);
  }
  return value;
}
