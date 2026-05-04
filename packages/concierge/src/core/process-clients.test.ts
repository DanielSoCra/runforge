import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { ConciergeConfig } from './config.js';
import {
  createCalendarAppleScriptClient,
  createGitHubCliClient,
  createMailAppleScriptClient,
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

  it('uses Mail through osascript for drafts and confirmed sends', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const client = createMailAppleScriptClient({
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: calls.length === 1 ? 'mail-draft-42\n' : 'sent\n' };
      },
    });

    await expect(client.draft({
      to: 'operator@example.com',
      subject: 'Daily prep',
      body: 'Agenda',
    })).resolves.toEqual({ draftId: 'mail-draft-42' });
    await expect(client.send('mail-draft-42')).resolves.toEqual({ sent: true, draftId: 'mail-draft-42' });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.file).toBe('osascript');
    expect(calls[0]?.args.at(0)).toBe('-e');
    expect(calls[0]?.args.at(1)).toContain('make new outgoing message');
    expect(calls[0]?.args.slice(-3)).toEqual(['operator@example.com', 'Daily prep', 'Agenda']);
    expect(calls[1]?.args.at(1)).toContain('send candidate');
    expect(calls[1]?.args.at(-1)).toBe('mail-draft-42');
  });

  it('reads upcoming Calendar events through read-only osascript JSON', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const client = createCalendarAppleScriptClient({
      execFile: async (file, args) => {
        calls.push({ file, args });
        return {
          stdout: JSON.stringify([
            {
              calendar: 'Work',
              title: 'Planning',
              start: '2026-05-04T10:00:00.000Z',
              end: '2026-05-04T10:30:00.000Z',
            },
          ]),
        };
      },
      lookaheadHours: 48,
    });

    await expect(client.read()).resolves.toEqual({
      events: [
        {
          calendar: 'Work',
          title: 'Planning',
          start: '2026-05-04T10:00:00.000Z',
          end: '2026-05-04T10:30:00.000Z',
        },
      ],
    });
    expect(calls).toEqual([
      {
        file: 'osascript',
        args: expect.arrayContaining(['-l', 'JavaScript', '48']),
      },
    ]);
    expect(calls[0]?.args.join('\n')).toContain("Application('Calendar')");
  });

  it('composes process runtime clients with real adapters where configured', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const clients = createProcessRuntimeClients(config, {
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      execFile: async (file, args) => {
        calls.push({ file, args });
        if (file === 'osascript' && args.join('\n').includes('application "Mail"')) {
          return { stdout: 'draft-1\n' };
        }
        return { stdout: '[]' };
      },
    });

    await expect(clients.github.search('repo:auto-claude')).resolves.toEqual({ items: [] });
    await expect(clients.secondBrain.search('anything')).resolves.toEqual({ matches: [] });
    await expect(clients.mail.draft({ to: 'a@example.com', subject: 's', body: 'b' }))
      .resolves.toEqual({ draftId: 'draft-1' });
    await expect(clients.calendar.read()).resolves.toEqual({ events: [] });
    expect(calls.some((call) => call.file === 'osascript')).toBe(true);
  });
});
