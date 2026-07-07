import { execFile as nodeExecFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import type { ConciergeRuntimeClients } from './runtime.js';
import type { ConciergeConfig } from './config.js';

export interface ExecFileResult {
  stdout: string;
}

export type ExecFile = (file: string, args: string[]) => Promise<ExecFileResult>;

export interface ProcessRuntimeClientOptions {
  fetch?: typeof fetch;
  execFile?: ExecFile;
}

export function createProcessRuntimeClients(
  config: ConciergeConfig,
  options: ProcessRuntimeClientOptions = {},
): ConciergeRuntimeClients {
  const fetchImpl = options.fetch ?? fetch;
  const execFile = options.execFile ?? defaultExecFile;
  return {
    slack: createSlackWebApiClient(config, fetchImpl),
    mail: createMailAppleScriptClient({ execFile }),
    github: createGitHubCliClient({ execFile }),
    calendar: createCalendarAppleScriptClient({ execFile }),
    observer: createObserverProcessClient({
      runforgeBaseUrl: config.runforgeBaseUrl,
      watchedRepos: config.watchedRepos,
      fetch: fetchImpl,
      execFile,
    }),
    secondBrain: createSecondBrainFileClient({ vaultPath: config.vaultPath }),
    web: { fetch: (url, init) => fetchImpl(url, init) },
  };
}

export function createGitHubCliClient(options: { execFile: ExecFile }): ConciergeRuntimeClients['github'] {
  return {
    search: async (query) => {
      const result = await options.execFile('gh', [
        'search',
        'issues',
        query,
        '--json',
        'title,url,number,repository',
        '--limit',
        '20',
      ]);
      return { items: JSON.parse(result.stdout) as unknown };
    },

    comment: async (input) => {
      await options.execFile('gh', [
        'issue',
        'comment',
        String(input.number),
        '--repo',
        input.repo,
        '--body',
        input.body,
      ]);
      return { ok: true };
    },
  };
}

export function createObserverProcessClient(options: {
  runforgeBaseUrl: string;
  watchedRepos: string[];
  fetch: typeof fetch;
  execFile: ExecFile;
}): ConciergeRuntimeClients['observer'] {
  return {
    recentActivity: async () => {
      const events: Array<{ repo: string; entries: string[] }> = [];
      for (const repo of options.watchedRepos) {
        const result = await options.execFile('git', [
          '-C',
          repo,
          'log',
          '--since=24 hours ago',
          '--format=%h %s',
          '-n',
          '20',
        ]);
        const entries = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (entries.length > 0) events.push({ repo, entries });
      }
      return { events };
    },

    daemonState: async () => {
      const token = process.env.RUNFORGE_CONTROL_TOKEN;
      const headers: Record<string, string> = {};
      if (token !== undefined && token !== '') {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await options.fetch(`${options.runforgeBaseUrl.replace(/\/+$/, '')}/status`, {
        method: 'GET',
        headers,
      });
      return readJsonBody(response);
    },
  };
}

export function createMailAppleScriptClient(options: { execFile: ExecFile }): ConciergeRuntimeClients['mail'] {
  return {
    draft: async (input) => {
      const result = await options.execFile('osascript', [
        '-e',
        MAIL_DRAFT_SCRIPT,
        '--',
        input.to,
        input.subject,
        input.body,
      ]);
      const draftId = result.stdout.trim();
      if (!draftId) throw new Error('Mail draft did not return a draft id');
      return { draftId };
    },

    send: async (draftId) => {
      await options.execFile('osascript', [
        '-e',
        MAIL_SEND_SCRIPT,
        '--',
        draftId,
      ]);
      return { sent: true, draftId };
    },
  };
}

export function createCalendarAppleScriptClient(options: {
  execFile: ExecFile;
  lookaheadHours?: number;
}): ConciergeRuntimeClients['calendar'] {
  const lookaheadHours = options.lookaheadHours ?? 24;

  return {
    read: async () => {
      const result = await options.execFile('osascript', [
        '-l',
        'JavaScript',
        '-e',
        CALENDAR_READ_SCRIPT,
        '--',
        String(lookaheadHours),
      ]);
      const parsed = JSON.parse(result.stdout.trim() || '[]') as unknown;
      if (!Array.isArray(parsed)) throw new Error('Calendar read did not return an array');
      return { events: parsed };
    },
  };
}

export function createSecondBrainFileClient(options: { vaultPath: string }): ConciergeRuntimeClients['secondBrain'] {
  const vaultRoot = resolve(options.vaultPath);

  return {
    read: async (path) => {
      const safePath = assertInsideVault(vaultRoot, path);
      return {
        path: safePath,
        body: await readFile(safePath, 'utf-8'),
      };
    },

    search: async (query) => {
      const matches: Array<{ path: string; preview: string }> = [];
      for (const path of await listMarkdownFiles(vaultRoot)) {
        const body = await readFile(path, 'utf-8');
        const preview = body
          .split(/\r?\n/)
          .find((line) => line.toLowerCase().includes(query.toLowerCase()));
        if (preview) matches.push({ path, preview });
      }
      return { matches };
    },

    appendInbox: async (input) => {
      const slug = safeSlug(input.slug);
      const path = join(vaultRoot, '00-inbox', `${slug}.md`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.body, 'utf-8');
      return { path };
    },

    writeDecision: async (path) => {
      const safePath = assertInsideVault(vaultRoot, path);
      await mkdir(dirname(safePath), { recursive: true });
      await writeFile(safePath, '', { encoding: 'utf-8', flag: 'a' });
      return { path: safePath };
    },

    writeClient: async (path) => {
      const safePath = assertInsideVault(vaultRoot, path);
      await mkdir(dirname(safePath), { recursive: true });
      await writeFile(safePath, '', { encoding: 'utf-8', flag: 'a' });
      return { path: safePath };
    },

    writeDailySummary: async (input) => {
      const path = assertInsideVault(
        vaultRoot,
        join(vaultRoot, '10-projects/concierge/daily-summaries', `${input.date}.md`),
      );
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.body, 'utf-8');
      return { path };
    },
  };
}

function createSlackWebApiClient(config: ConciergeConfig, fetchImpl: typeof fetch): ConciergeRuntimeClients['slack'] {
  return {
    postMessage: async (input) => {
      const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.slackBotToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      });
      const body = await readJsonBody(response);
      if (!response.ok || body.ok === false) {
        throw new Error(`slack postMessage failed: ${JSON.stringify(body)}`);
      }
      return body;
    },
  };
}

async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : { value: parsed };
}

async function defaultExecFile(file: string, args: string[]): Promise<ExecFileResult> {
  return new Promise((resolvePromise, reject) => {
    nodeExecFile(file, args, { encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolvePromise({ stdout: String(stdout) });
    });
  });
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(path));
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      files.push(path);
    }
  }
  return files.sort();
}

function assertInsideVault(vaultRoot: string, path: string): string {
  const resolved = resolve(path);
  const rel = relative(vaultRoot, resolved);
  if (rel.startsWith('..') || rel === '..' || resolve(vaultRoot, rel) !== resolved) {
    throw new Error('path is outside the configured knowledge vault');
  }
  return resolved;
}

function safeSlug(slug: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(slug)) {
    throw new Error('slug contains unsupported characters');
  }
  return slug;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

const MAIL_DRAFT_SCRIPT = `
on run argv
  set recipientAddress to item 1 of argv
  set messageSubject to item 2 of argv
  set messageBody to item 3 of argv
  tell application "Mail"
    set newMessage to make new outgoing message with properties {subject:messageSubject, content:messageBody, visible:false}
    tell newMessage
      make new to recipient at end of to recipients with properties {address:recipientAddress}
      save
    end tell
    return id of newMessage as string
  end tell
end run
`.trim();

const MAIL_SEND_SCRIPT = `
on run argv
  set draftId to item 1 of argv
  tell application "Mail"
    repeat with candidate in outgoing messages
      if (id of candidate as string) is draftId then
        send candidate
        return "sent"
      end if
    end repeat
  end tell
  error "draft not found: " & draftId
end run
`.trim();

const CALENDAR_READ_SCRIPT = `
function run(argv) {
  const lookaheadHours = Number(argv[0] || '24');
  const start = new Date();
  const end = new Date(start.getTime() + lookaheadHours * 60 * 60 * 1000);
  const Calendar = Application('Calendar');
  const events = [];
  for (const calendar of Calendar.calendars()) {
    for (const event of calendar.events()) {
      const eventStart = event.startDate();
      if (!(eventStart instanceof Date) || eventStart < start || eventStart >= end) continue;
      const eventEnd = event.endDate();
      events.push({
        calendar: calendar.name(),
        title: event.summary(),
        start: eventStart.toISOString(),
        end: eventEnd instanceof Date ? eventEnd.toISOString() : null,
        location: event.location() || undefined,
      });
    }
  }
  events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  return JSON.stringify(events);
}
`.trim();
