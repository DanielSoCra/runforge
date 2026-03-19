import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const res = await fetch(`${process.env.DAEMON_URL}/status`, {
      signal: AbortSignal.timeout(3000),
      next: { revalidate: 10 },
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json(
      { state: 'offline', active_runs: 0, version: 'unknown' },
      { status: 503 }
    );
  }
}
