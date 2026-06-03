import { describe, it, expect } from 'vitest';
import { LogNotifier, RecordingSourceSink, AckResumeDispatcher } from './adapters.js';

describe('v1 decision-escalation adapters', () => {
  describe('LogNotifier', () => {
    it('notify logs the args and returns "sent", then probe reports "applied"', async () => {
      const n = new LogNotifier();
      const out = await n.notify({ decision_id: 'd1', channel: 'log', effectId: 'eff-1' });
      expect(out).toBe('sent');
      expect(n.calls).toEqual([{ decision_id: 'd1', channel: 'log', effectId: 'eff-1' }]);
      expect(await n.probe('eff-1')).toBe('applied');
    });

    it('probe reports "absent" for an unknown effect id', async () => {
      const n = new LogNotifier();
      expect(await n.probe('nope')).toBe('absent');
    });
  });

  describe('RecordingSourceSink', () => {
    it('writeResponse records the call and returns {status:"written"}, then exists reports "applied"', async () => {
      const s = new RecordingSourceSink();
      const res = await s.writeResponse({
        decision_id: 'd1',
        responseRef: 'resp-1',
        expectedSourceEtag: 'etag-0',
        effectId: 'eff-w',
        sourceLocator: 'https://example.test/1',
        responsePayloadJson: JSON.stringify({ chosen_option: 'approve' }),
        answerRef: null,
        hasProtectedAnswer: false,
      });
      expect(res).toEqual({ status: 'written' });
      expect(s.calls).toHaveLength(1);
      expect(await s.exists('eff-w')).toBe('applied');
    });

    it('exists reports "absent" for an unknown effect id', async () => {
      const s = new RecordingSourceSink();
      expect(await s.exists('nope')).toBe('absent');
    });

    it('currentEtag defaults to {status:"equal"} echoing the expected etag (never strands at source_written)', async () => {
      const s = new RecordingSourceSink();
      const r = await s.currentEtag('https://example.test/1', 'etag-0');
      expect(r.status).toBe('equal');
      expect(r.currentSourceEtag).toBe('etag-0');
    });

    it('markSuperseded records the supersession', async () => {
      const s = new RecordingSourceSink();
      await s.markSuperseded('d1', 'etag-1');
      expect(s.superseded).toEqual([{ decision_id: 'd1', newEtag: 'etag-1' }]);
    });
  });

  describe('AckResumeDispatcher', () => {
    it('resume records the call and returns "acked", then status reports "applied"', async () => {
      const r = new AckResumeDispatcher();
      const out = await r.resume({ decision_id: 'd1', mode: 'requeue', effectId: 'eff-r' });
      expect(out).toBe('acked');
      expect(r.calls).toHaveLength(1);
      expect(await r.status('eff-r')).toBe('applied');
    });

    it('status reports "absent" for an unknown effect id', async () => {
      const r = new AckResumeDispatcher();
      expect(await r.status('nope')).toBe('absent');
    });
  });
});
