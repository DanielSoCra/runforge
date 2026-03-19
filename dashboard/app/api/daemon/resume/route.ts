import { NextResponse } from 'next/server';

export async function POST() {
  try {
    const res = await fetch(`${process.env.DAEMON_URL}/resume`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: 'Daemon unreachable' }, { status: 503 });
  }
}
