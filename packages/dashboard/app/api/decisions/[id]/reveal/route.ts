/**
 * STACK-AC-OPERATOR-SURFACE-CLIENT — admin-gated proxy for operator REVEAL.
 *
 * The dashboard's only door to the daemon control server's
 * `POST /decisions/:id/reveal` (STACK-AC-OPERATOR-SURFACE-API, slice 5b). Reveal
 * returns decrypted withheld content, so it MUST be admin-only. The handler:
 *
 *   (1) guards with `requireDashboardAdmin` — rejects unauthenticated/non-admin
 *       with the auth error's status and NEVER calls the daemon;
 *   (2) validates `body.ref` is a non-empty string, returning a calm 400 on
 *       malformed input (never a thrown 500);
 *   (3) forwards `{ ref, actor }` to the daemon at
 *       `/decisions/<percent-encoded id>/reveal` via `daemonFetch`;
 *   (4) returns the daemon's status + JSON body verbatim.
 *
 * FAIL-SAFE: `DaemonConfigError` → 500; fetch rejection → 503; non-JSON daemon
 * body → 502 (mirrors the answer route's degraded-error handling).
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  getDashboardAuthError,
  requireDashboardAdmin,
  type DashboardSession,
} from '@/lib/auth/require-session';
import { daemonFetch, DaemonAuthError, DaemonConfigError } from '@/lib/daemon-fetch';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const MAX_BODY_BYTES = 10240; // 10KB — the reveal payload is a tiny {ref}

/**
 * Read the request body with a hard byte cap, independent of the Content-Length
 * header — a chunked or header-spoofed request cannot bypass the limit. Throws
 * `Error('BODY_TOO_LARGE')` past the cap (stops reading the stream).
 */
async function readBoundedText(request: NextRequest, maxBytes: number): Promise<string> {
  const stream = request.body;
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
  }
  if (total === 0) return '';
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export async function POST(
  request: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  let session: DashboardSession;
  try {
    // Reveal returns secrets and is therefore admin-only.
    session = await requireDashboardAdmin();
  } catch (e) {
    const error = getDashboardAuthError(e);
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const actor = session.user.email ?? session.user.id;

  // Read the body under a hard 10KB cap (independent of Content-Length, so a
  // chunked/spoofed-length admin request can't force unbounded buffering).
  let raw: string;
  try {
    raw = await readBoundedText(request, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof Error && e.message === 'BODY_TOO_LARGE') {
      return NextResponse.json({ error: 'Body too large' }, { status: 413 });
    }
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  let body: { ref?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const ref = typeof body.ref === 'string' ? body.ref : '';
  if (ref.length === 0) {
    return NextResponse.json({ error: 'ref is required' }, { status: 400 });
  }

  const { id } = await ctx.params;

  try {
    const res = await daemonFetch(
      `/decisions/${encodeURIComponent(id)}/reveal`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref, actor }),
      },
    );

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return NextResponse.json(
        { error: `Daemon returned non-JSON response (HTTP ${res.status})` },
        { status: 502 },
      );
    }

    return NextResponse.json(json, { status: res.status });
  } catch (e) {
    if (e instanceof DaemonConfigError || e instanceof DaemonAuthError) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Daemon unreachable' },
      { status: 503 },
    );
  }
}
