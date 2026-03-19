import { NextResponse } from 'next/server';

export async function POST() {
  try {
    const res = await fetch(`${process.env.DAEMON_URL}/pause`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    return NextResponse.json(json, { status: res.status });
  } catch {
    return NextResponse.json({ error: 'Daemon unreachable' }, { status: 503 });
  }
}
