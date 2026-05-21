import { describe, expect, it } from 'vitest';
import { loadConciergeConfig } from './config.js';

const CONFIG_JSON = JSON.stringify({
  slackBotToken: 'xoxb-file',
  slackSigningSecret: 'secret-file',
  operatorSlackUserId: 'U-file',
  anthropicApiKey: 'sk-file',
  modelId: 'claude-sonnet-4-6',
  tunnelHostname: 'concierge.example.com',
  boardHostname: 'board.example.com',
  vaultPath: '/vault',
  watchedRepos: ['/repo'],
  operatorEmail: 'operator@example.com',
});

describe('concierge config loader', () => {
  it('loads config from JSON and applies environment overrides', async () => {
    const config = await loadConciergeConfig({
      configPath: '/config.json',
      readFile: async (path) => {
        expect(path).toBe('/config.json');
        return CONFIG_JSON;
      },
      env: {
        CONCIERGE_SLACK_BOT_TOKEN: 'xoxb-env',
        CONCIERGE_AUTO_CLAUDE_BASE_URL: 'http://daemon',
      },
    });

    expect(config.slackBotToken).toBe('xoxb-env');
    expect(config.autoClaudeBaseUrl).toBe('http://daemon');
    expect(config.operatorEmail).toBe('operator@example.com');
  });

  it('rejects malformed config instead of starting with partial secrets', async () => {
    await expect(loadConciergeConfig({
      configPath: '/bad.json',
      readFile: async () => JSON.stringify({ watchedRepos: 'not-array' }),
      env: {},
    })).rejects.toThrow(/slackBotToken must be a string/);
  });
});
