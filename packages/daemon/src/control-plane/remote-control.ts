import { spawn, type ChildProcess } from 'child_process';

export type RemoteControlState = 'offline' | 'active' | 'failed';

export interface RemoteControlStatus {
  remote_control_state: RemoteControlState;
  remote_control_url: string | null;
}

const MAX_FAILURES = 3;
const BACKOFF_MS = [5_000, 15_000, 30_000]; // indexed by attempt (0-based)

export class RemoteControlManager {
  private state: RemoteControlState = 'offline';
  private url: string | null = null;
  private proc: ChildProcess | null = null;
  private failureCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  start(): void {
    if (this.proc) {
      console.warn('[remote-control] start() called while already running — ignoring');
      return;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.stopped = false;
    this.failureCount = 0;
    this.state = 'offline';
    this.spawn();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    this.state = 'offline';
    this.url = null;
  }

  getState(): RemoteControlStatus {
    return {
      remote_control_state: this.state,
      remote_control_url: this.url,
    };
  }

  private spawn(): void {
    if (this.stopped) return;

    const proc = spawn('claude', ['remote-control'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;

    let stdoutBuffer = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const match = line.match(/https:\/\/[^\s,;)'"]+/);
        if (match && this.state !== 'active') {
          // Strip trailing period (not excluded in the regex above but common punctuation)
          this.url = match[0].replace(/[.,;)'"]+$/, '');
          this.state = 'active';
          this.failureCount = 0;
        }
      }
    });

    proc.stderr?.pipe(process.stderr);

    proc.on('exit', (code: number | null) => {
      if (this.stopped) return;
      const wasActive = this.state === 'active';
      this.state = 'offline';
      this.url = null;
      this.proc = null;
      // Count as failure unless the session exited cleanly after becoming active.
      // Repeated clean exits without ever producing a URL still count toward the limit.
      this.scheduleRestart(code !== 0 || !wasActive);
    });

    proc.on('error', (err: Error) => {
      if (this.stopped) return;
      this.proc = null;
      this.state = 'offline';
      this.url = null;
      console.error('[remote-control] Spawn error:', err.message);
      this.scheduleRestart(true);
    });
  }

  private scheduleRestart(countAsFailure = true): void {
    if (this.stopped) return;
    if (countAsFailure) {
      this.failureCount++;
      if (this.failureCount >= MAX_FAILURES) {
        this.state = 'failed';
        console.error('[remote-control] Too many restart failures — manual intervention required');
        return;
      }
    }
    const delay = BACKOFF_MS[Math.min(this.failureCount - 1, BACKOFF_MS.length - 1)];
    if (countAsFailure) {
      console.warn(`[remote-control] Process exited (attempt ${this.failureCount}/${MAX_FAILURES}), restarting in ${delay}ms`);
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, delay);
  }
}
