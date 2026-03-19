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
    this.stopped = false;
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

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      // Match https:// URLs, stopping at whitespace or common trailing punctuation.
      // claude remote-control prints the session URL in its startup output.
      const match = text.match(/https:\/\/[^\s,;)'"]+/);
      if (match && this.state !== 'active') {
        // Strip any trailing punctuation that leaked past the character class
        this.url = match[0].replace(/[.,;)'"]+$/, '');
        this.state = 'active';
        this.failureCount = 0;
      }
    });

    proc.on('exit', () => {
      if (this.stopped) return;
      this.state = 'offline';
      this.url = null;
      this.proc = null;
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.stopped) return;
    this.failureCount++;

    if (this.failureCount >= MAX_FAILURES) {
      this.state = 'failed';
      console.error('[remote-control] Too many restart failures — manual intervention required');
      return;
    }

    const delay = BACKOFF_MS[Math.min(this.failureCount - 1, BACKOFF_MS.length - 1)];
    console.warn(`[remote-control] Process exited (attempt ${this.failureCount}/${MAX_FAILURES}), restarting in ${delay}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, delay);
  }
}
