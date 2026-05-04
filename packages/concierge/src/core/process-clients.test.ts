import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { ConciergeConfig } from './config.js';
import {
  createGitHubCliClient,
  createObserverProcessClient,
  createProcessRuntimeClients,
  createSecondBrainFileClient,
} from './process-clients.js';

const config: ConciergeConfig = {
  slackBotToken: 'xoxb-token',
  slackSigningSecret: 'secret',
  operatorSlackUserId: 'U123',
  anthropicApiKey: 'sk-test',
  modelId: 'claude-sonnet-4-6',
  tunnelHostname: 'concierge.example.com',
  boardHostname: 'board.example.com',
  vaultPath: '/vault',
  watchedRepos: ['/repo'],
  operatorEmail: 'operator@example.com',
  autoClaudeBaseUrl: 'http://127.0.0.1:3847',
};

describe('process runtime clients', () => {
  it('creates a knowledge-vault file client for vault reads, search, inbox append, and writes', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'concierge-vault-'));
    const client = createSecondBrainFileClient({ vaultPath });

    await client.appendInbox({ slug: 'capture', body: 'remember this decision' });
    await client.writeDecision(`${vaultPath}/10-projects/auto-claude/decision.md`);
    await client.writeClient(`${vaultPath}/20-Areas/clients/acme/note.md`);

    await expect(client.read(`${vaultPath}/00-inbox/capture.md`)).resolves.toEqual({
      path: `${vaultPath}/00-inbox/capture.md`,
      body: 'remember this decision',
    });
    await expect(client.search('decision')).resolves.toEqual({
      matches: [
        { path: `${vaultPath}/00-inbox/capture.md`, preview: 'remember this decision' },
      ],
    });
    await expect(readFile(`${vaultPath}/10-projects/auto-claude/decision.md`, 'utf-8'))
      .resolves.toBe('');
    await expect(readFile(`${vaultPath}/20-Areas/clients/acme/note.md`, 'utf-8'))
      .resolves.toBe('');
  });

  it('rejects unsafe knowledge-vault inbox slugs before writing', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'concierge-vault-'));
    const client = createSecondBrainFileClient({ vaultPath });

    await expect(client.appendInbox({ slug: '../escape', body: 'nope' }))
      .rejects.toThrow(/slug contains unsupported characters/);
  });

  it('uses gh CLI for GitHub search and comments', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const client = createGitHubCliClient({
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: JSON.stringify([{ title: 'Issue', url: 'https://example.test/1' }]) };
      },
    });

    await expect(client.search('repo:owner/repo bug')).resolves.toEqual({
      items: [{ title: 'Issue', url: 'https://example.test/1' }],
    });
    await expect(client.comment({ repo: 'owner/repo', number: 12, body: 'done' }))
      .resolves.toEqual({ ok: true });

    expect(calls).toEqual([
      {
        file: 'gh',
        args: ['search', 'issues', 'repo:owner/repo bug', '--json', 'title,url,number,repository', '--limit', '20'],
      },
      {
        file: 'gh',
        args: ['issue', 'comment', '12', '--repo', 'owner/repo', '--body', 'done'],
      },
    ]);
  });

  it('reads daemon state and recent git activity through the observer process client', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const client = createObserverProcessClient({
      autoClaudeBaseUrl: 'http://127.0.0.1:3847',
      watchedRepos: ['/repo/a', '/repo/b'],
      fetch: async (url) => new Response(JSON.stringify({ paused: true, url: String(url) }), { status: 200 }),
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: args.includes('/repo/a') ? 'abc first\n' : '' };
      },
    });

    await expect(client.daemonState()).resolves.toEqual({
      paused: true,
      url: 'http://127.0.0.1:3847/status',
    });
    await expect(client.recentActivity()).resolves.toEqual({
      events: [{ repo: '/repo/a', entries: ['abc first'] }],
    });
    expect(calls).toEqual([
      {
        file: 'git',
        args: ['-C', '/repo/a', 'log', '--since=24 hours ago', '--format=%h %s', '-n', '20'],
      },
      {
        file: 'git',
        args: ['-C', '/repo/b', 'log', '--since=24 hours ago', '--format=%h %s', '-n', '20'],
      },
    ]);
  });

  it('composes process runtime clients with real adapters where configured', async () => {
    const clients = createProcessRuntimeClients(config, {
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      execFile: async () => ({ stdout: '[]' }),
    });

    await expect(clients.github.search('repo:auto-claude')).resolves.toEqual({ items: [] });
    await expect(clients.secondBrain.search('anything')).resolves.toEqual({ matches: [] });
    await expect(clients.mail.draft({ to: 'a@example.com', subject: 's', body: 'b' }))
      .rejects.toThrow(/mail client is not configured/);
  });
});
