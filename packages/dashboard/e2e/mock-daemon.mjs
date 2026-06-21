// Minimal mock daemon control server for the operator-surface e2e smoke.
// Serves the three Decision API endpoints the surface reads, with deterministic
// seeded fixtures, so the smoke exercises the real cross-layer path
// (browser -> dashboard proxy route -> daemonFetch -> daemon) without a live daemon.
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_DAEMON_PORT) || 9899;

const PENDING = [
  {
    decision_id: 'dec-e2e-1',
    status: 'notified',
    risk_class: 'P1',
    created_at: '2026-06-21T09:30:00.000Z',
    question: { kind: 'text', value: 'Merge PR #482 into main?' },
    options: [
      { id: 'approve', label: { kind: 'text', value: 'Approve' } },
      { id: 'reject', label: { kind: 'text', value: 'Reject' } },
    ],
    score: 87,
    why_ranked: 'P1 risk, waiting 2h',
  },
];

const DETAIL = {
  decision_id: 'dec-e2e-1',
  status: 'notified',
  risk_class: 'P1',
  deployment: 'dep-main',
  source_url: 'https://github.com/org/repo/issues/482',
  reversibility: 'reversible',
  recommended_option: 'approve',
  expires_at: null,
  created_at: '2026-06-21T09:30:00.000Z',
  question: { kind: 'text', value: 'Merge PR #482 into main?' },
  context: { kind: 'text', value: 'Touches the auth module.' },
  consequence_of_no_answer: { kind: 'text', value: 'The run stays parked.' },
  options: [
    { id: 'approve', label: { kind: 'text', value: 'Approve' } },
    { id: 'reject', label: { kind: 'text', value: 'Reject' } },
  ],
};

const server = createServer((req, res) => {
  const url = (req.url ?? '').split('?')[0];
  res.setHeader('content-type', 'application/json');
  if (url === '/decisions/pending') {
    res.end(JSON.stringify(PENDING));
    return;
  }
  if (url.startsWith('/decisions/') && url.endsWith('/answer') && req.method === 'POST') {
    res.end(JSON.stringify({ answered: true, chosen_option: 'approve' }));
    return;
  }
  if (url.startsWith('/decisions/')) {
    res.end(JSON.stringify(DETAIL));
    return;
  }
  // Briefing/other endpoints: empty so the dashboard degrades calmly.
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`[mock-daemon] listening on http://localhost:${PORT}`);
});
