import { describe, expect, it } from 'vitest';
import { createDefaultToolEntries, createDefaultToolRegistry } from './default-tools.js';

describe('default concierge tools', () => {
  it('declares the initial fixed toolbox from the tool-registry spec', () => {
    const names = createDefaultToolEntries().map((entry) => entry.name);

    expect(names).toEqual([
      'ac_run',
      'ac_status',
      'ac_pause',
      'ac_unstuck',
      'ac_merge_to_main',
      'sb_read',
      'sb_search',
      'sb_append_inbox',
      'sb_write_decision',
      'sb_write_client',
      'gh_search',
      'gh_comment',
      'cal_read',
      'mail_draft',
      'mail_send',
      'slack_send_dm',
      'slack_send_channel',
      'web_fetch',
      'obs_recent_activity',
      'obs_daemon_state',
    ]);
  });

  it('marks externally visible or irreversible tools as high blast radius', () => {
    const registry = createDefaultToolRegistry();

    expect(registry.get('ac_merge_to_main')?.blastRadius).toBe('high');
    expect(registry.get('sb_write_client')?.blastRadius).toBe('high');
    expect(registry.get('mail_send')?.blastRadius).toBe('high');
    expect(registry.get('slack_send_channel')?.blastRadius).toBe('high');
  });

  it('uses not-configured handlers instead of silently pretending integrations exist', async () => {
    const entry = createDefaultToolRegistry().get('ac_status');

    await expect(entry?.handler({}, { conversationId: 'c1', toolCallId: 't1' })).rejects.toThrow(
      /handler not configured for ac_status/,
    );
  });
});
