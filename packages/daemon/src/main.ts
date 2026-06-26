import { fileURLToPath } from 'node:url';

import { Command } from 'commander';
import { config as loadDotenv } from 'dotenv';
import { startDaemon } from './control-plane/daemon.js';
import { processSingleIssue } from './control-plane/process-single.js';

const program = new Command();
program
  .name('auto-claude')
  .description('Autonomous spec implementation daemon')
  .version('0.1.0');

program
  .command('start')
  .description('Start the daemon')
  .option('-c, --config <path>', 'Config file path', 'auto-claude.config.json')
  .action(async (options: { config: string }) => {
    loadDotenv();
    const result = await startDaemon(options.config);
    if (!result.ok) {
      console.error(formatStartupError(result.error));
      process.exit(1);
    }
  });

program
  .command('process <issue>')
  .description('Process a single issue by number (one-shot)')
  .option('-c, --config <path>', 'Config file path', 'auto-claude.config.json')
  .action(async (issue: string, options: { config: string }) => {
    loadDotenv();
    const issueNumber = Number(issue);
    if (isNaN(issueNumber)) {
      console.error(`Invalid issue number: ${issue}`);
      process.exit(1);
    }
    const result = await processSingleIssue(issueNumber, options.config);
    if (!result.ok) {
      console.error(`Failed: ${result.error.message}`);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show daemon status')
  .option('-p, --port <number>', 'Control port', '3847')
  .action(async (options: { port: string }) => {
    await callApi(Number(options.port), 'GET', '/status');
  });

program
  .command('pause')
  .description('Pause the daemon')
  .option('-p, --port <number>', 'Control port', '3847')
  .action(async (options: { port: string }) => {
    await callApi(Number(options.port), 'POST', '/pause');
  });

program
  .command('resume')
  .description('Resume the daemon')
  .option('-p, --port <number>', 'Control port', '3847')
  .action(async (options: { port: string }) => {
    await callApi(Number(options.port), 'POST', '/resume');
  });

program
  .command('retry <issue>')
  .description('Retry a stuck issue')
  .option('-p, --port <number>', 'Control port', '3847')
  .action(async (issue: string, options: { port: string }) => {
    await callApi(Number(options.port), 'POST', `/retry/${issue}`);
  });

program
  .command('health')
  .description('Check daemon health')
  .option('-p, --port <number>', 'Control port', '3847')
  .action(async (options: { port: string }) => {
    await callApi(Number(options.port), 'GET', '/health');
  });

/**
 * Format a startup failure, walking up to 5 `error.cause` layers so the
 * underlying driver code (e.g. `ECONNREFUSED`, `28P01`) is visible instead of
 * only the opaque outer message.
 */
export function formatStartupError(error: Error): string {
  const lines = [`Failed to start: ${error.message}`];
  const seen = new Set<unknown>([error]);
  let current: unknown = (error as { cause?: unknown }).cause;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const code = causeCode(current);
    const message = causeMessage(current);
    lines.push(`  caused by:${code !== null ? ` [${code}]` : ''} ${message}`);
    if (typeof current === 'object') {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return lines.join('\n');
}

function causeCode(value: unknown): string | null {
  if (value != null && typeof value === 'object') {
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    if (typeof code === 'number') return String(code);
  }
  return null;
}

function causeMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value != null && typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(value);
}

// Only parse argv when run as the CLI entrypoint, not when imported (tests).
const isEntrypoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  program.parseAsync().catch((e: unknown) => {
    const error = e instanceof Error ? e : new Error(String(e));
    console.error(formatStartupError(error));
    process.exit(1);
  });
}

async function callApi(port: number, method: string, path: string): Promise<void> {
  try {
    const headers: Record<string, string> = {};
    if (method === 'POST') headers['X-Requested-By'] = 'cli';
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      const text = await res.text().catch(() => '');
      const preview = text.slice(0, 200);
      console.error(
        `Daemon returned non-JSON response (HTTP ${res.status})${preview ? `: ${preview}` : ''}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(body, null, 2));
    if (!res.ok) process.exitCode = 1;
  } catch {
    console.error(`Failed to connect to daemon on port ${port}. Is it running?`);
    process.exitCode = 1;
  }
}
