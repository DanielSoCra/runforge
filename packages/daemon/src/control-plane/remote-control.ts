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
      // Do NOT null this.proc here — the exit event will do it.
      // Nulling before the exit fires creates a window where start() can
      // spawn a new process; the old process's exit then calls scheduleRestart
      // with this.stopped=false (reset by start()), causing a spurious restart.
    }
    this.state = 'offline';
    this.url = null;
  }

  restart(): void {
    // stop() sets this.stopped = true and kills any running process.
    // We must reset stopped before calling start() or start() will return early.
    void this.stop();
    this.stopped = false;
    this.failureCount = 0;
    this.spawn();
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
      if (this.proc !== proc) return; // Stale exit — a newer process has already been spawned
      this.proc = null;
      if (this.stopped) return;
      const wasActive = this.state === 'active';
      this.state = 'offline';
      this.url = null;
      // Count as failure unless the session exited cleanly after becoming active.
      // Repeated clean exits without ever producing a URL still count toward the limit.
      this.scheduleRestart(code !== 0 || !wasActive);
    });

    proc.on('error', (err: Error) => {
      if (this.proc !== proc) return; // Stale error — a newer process has already been spawned
      this.proc = null;
      if (this.stopped) return;
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
