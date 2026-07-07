import { describe, expect, it } from 'vitest';
import { createCalendarToolHandlers } from './cal.js';
import { createGitHubToolHandlers } from './gh.js';
import { createMailToolHandlers } from './mail.js';
import { createObserverToolHandlers } from './obs.js';
import { createSecondBrainToolHandlers } from './sb.js';
import { createSlackToolHandlers } from './slack.js';

describe('external client tool handlers', () => {
  it('routes Slack DM and channel sends through the injected Slack client', async () => {
    const calls: unknown[] = [];
    const handlers = createSlackToolHandlers({
      operatorUserId: 'U123',
      client: {
        postMessage: async (input) => {
          calls.push(input);
          return { ts: '1.2' };
        },
      },
    });

    await handlers.slack_send_dm({ text: 'hi' }, { conversationId: 'c1', toolCallId: 't1' });
    await handlers.slack_send_channel({ channel: 'C123', text: 'public' }, { conversationId: 'c1', toolCallId: 't2' });

    expect(calls).toEqual([
      { channel: 'U123', text: 'hi' },
      { channel: 'C123', text: 'public' },
    ]);
  });

  it('routes email draft/send through the injected mail client', async () => {
    const handlers = createMailToolHandlers({
      client: {
        draft: async (input) => ({ draftId: `${input.to}:${input.subject}` }),
        send: async (draftId) => ({ sent: true, draftId }),
      },
    });

    await expect(handlers.mail_draft({
      to: 'person@example.com',
      subject: 'Hello',
      body: 'Body',
    }, { conversationId: 'c1', toolCallId: 't1' })).resolves.toEqual({
      draftId: 'person@example.com:Hello',
    });
    await expect(handlers.mail_send({ draftId: 'd1' }, { conversationId: 'c1', toolCallId: 't2' }))
      .resolves.toEqual({ sent: true, draftId: 'd1' });
  });

  it('routes GitHub search/comment through the injected GitHub client', async () => {
    const handlers = createGitHubToolHandlers({
      client: {
        search: async (query) => ({ items: [`result:${query}`] }),
        comment: async (input) => ({ url: `${input.repo}#${input.number}` }),
      },
    });

    await expect(handlers.gh_search({ query: 'repo:runforge' }, { conversationId: 'c1', toolCallId: 't1' }))
      .resolves.toEqual({ items: ['result:repo:runforge'] });
    await expect(handlers.gh_comment({
      repo: 'owner/repo',
      number: 1,
      body: 'done',
    }, { conversationId: 'c1', toolCallId: 't2' })).resolves.toEqual({ url: 'owner/repo#1' });
  });

  it('routes calendar and observer reads through injected clients', async () => {
    const cal = createCalendarToolHandlers({
      client: { read: async () => ({ events: ['standup'] }) },
    });
    const obs = createObserverToolHandlers({
      client: {
        recentActivity: async () => ({ events: ['commit'] }),
        daemonState: async () => ({ paused: true }),
      },
    });

    await expect(cal.cal_read({}, { conversationId: 'c1', toolCallId: 't1' }))
      .resolves.toEqual({ events: ['standup'] });
    await expect(obs.obs_recent_activity({}, { conversationId: 'c1', toolCallId: 't2' }))
      .resolves.toEqual({ events: ['commit'] });
    await expect(obs.obs_daemon_state({}, { conversationId: 'c1', toolCallId: 't3' }))
      .resolves.toEqual({ paused: true });
  });

  it('routes knowledge-base operations through the vault policy and client', async () => {
    const handlers = createSecondBrainToolHandlers({
      vaultPath: '/vault',
      allowList: ['00-inbox', '10-projects'],
      confirmationRequired: ['20-Areas/clients'],
      client: {
        read: async (path) => ({ path, body: 'note' }),
        search: async (query) => ({ matches: [query] }),
        appendInbox: async (input) => ({ path: `/vault/00-inbox/${input.slug}.md` }),
        writeDecision: async (path) => ({ path }),
        writeClient: async (path) => ({ path }),
      },
    });

    await expect(handlers.sb_read({ path: '/vault/00-inbox/a.md' }, { conversationId: 'c1', toolCallId: 't1' }))
      .resolves.toEqual({ path: '/vault/00-inbox/a.md', body: 'note' });
    await expect(handlers.sb_search({ query: 'decision' }, { conversationId: 'c1', toolCallId: 't2' }))
      .resolves.toEqual({ matches: ['decision'] });
    await expect(handlers.sb_append_inbox({ slug: 'capture', body: 'text' }, { conversationId: 'c1', toolCallId: 't3' }))
      .resolves.toEqual({ path: '/vault/00-inbox/capture.md' });
    await expect(handlers.sb_write_decision({ path: '/vault/private.md' }, { conversationId: 'c1', toolCallId: 't4' }))
      .rejects.toThrow(/path is outside allowed vault prefixes/);
  });
});
