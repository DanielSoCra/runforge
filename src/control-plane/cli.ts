import { Command } from 'commander';

export function createCli(): Command {
  const program = new Command();
  program
    .name('auto-claude')
    .description('Autonomous spec implementation daemon')
    .version('0.1.0');

  program
    .command('start')
    .description('Start the daemon')
    .option('-c, --config <path>', 'Config file path', 'auto-claude.config.json')
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

async function callApi(port: number, method: string, path: string): Promise<void> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    const body = await res.json();
    console.log(JSON.stringify(body, null, 2));
    if (!res.ok) process.exitCode = 1;
  } catch {
    console.error(`Failed to connect to daemon on port ${port}. Is it running?`);
    process.exitCode = 1;
  }
}
