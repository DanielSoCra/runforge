import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';

export function createCli(): Command {
  const program = new Command();
  program
    .name('runforge')
    .description('Autonomous spec implementation daemon')
    .version('0.1.0');

  program
    .command('start')
    .description('Start the daemon')
    .option('-c, --config <path>', 'Config file path', 'runforge.config.json')
    .action(async (options) => {
      // Will be wired to daemon startup in Task 26
      console.log(`Starting daemon with config: ${options.config}`);
    });

  program
    .command('status')
    .description('Show daemon status')
    .option('-p, --port <number>', 'Control port', '3847')
    .action(async (options) => {
      await callApi(Number(options.port), 'GET', '/status');
    });

  program
    .command('pause')
    .description('Pause the daemon')
    .option('-p, --port <number>', 'Control port', '3847')
    .action(async (options) => {
      await callApi(Number(options.port), 'POST', '/pause');
    });

  program
    .command('resume')
    .description('Resume the daemon')
    .option('-p, --port <number>', 'Control port', '3847')
    .action(async (options) => {
      await callApi(Number(options.port), 'POST', '/resume');
    });

  program
    .command('retry <issue>')
    .description('Retry a stuck issue')
    .option('-p, --port <number>', 'Control port', '3847')
    .action(async (issue, options) => {
      await callApi(Number(options.port), 'POST', `/retry/${issue}`);
    });

  program
    .command('health')
    .description('Check daemon health')
    .option('-p, --port <number>', 'Control port', '3847')
    .action(async (options) => {
      await callApi(Number(options.port), 'GET', '/health');
    });

  return program;
}

function resolveControlToken(): string | undefined {
  const envToken = process.env.RUNFORGE_CONTROL_TOKEN;
  if (envToken !== undefined && envToken !== '') return envToken;

  try {
    const envPath = resolve(process.cwd(), '.env.mac');
    const contents = readFileSync(envPath, 'utf-8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^RUNFORGE_CONTROL_TOKEN=(.+)$/);
      if (match) {
        const value = match[1]?.trim();
        if (value !== undefined && value.length > 0) return value;
      }
    }
  } catch {
    // .env.mac missing or unreadable — fine; /health works tokenless either way.
  }
  return undefined;
}

async function callApi(port: number, method: string, path: string): Promise<void> {
  try {
    const headers: Record<string, string> = {};
    if (method === 'POST') headers['X-Requested-By'] = 'cli';
    const token = resolveControlToken();
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers });
    const body = await res.json();
    console.log(JSON.stringify(body, null, 2));
    if (!res.ok) process.exitCode = 1;
  } catch {
    console.error(`Failed to connect to daemon on port ${port}. Is it running?`);
    process.exitCode = 1;
  }
}
