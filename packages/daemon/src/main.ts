import { Command } from 'commander';
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
    const result = await startDaemon(options.config);
    if (!result.ok) {
      console.error(`Failed to start: ${result.error.message}`);
      process.exit(1);
    }
  });

program
  .command('process <issue>')
  .description('Process a single issue by number (one-shot)')
  .option('-c, --config <path>', 'Config file path', 'auto-claude.config.json')
  .action(async (issue: string, options: { config: string }) => {
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

program.parse();

async function callApi(port: number, method: string, path: string): Promise<void> {
  try {
    const headers: Record<string, string> = {};
    if (method === 'POST') headers['X-Requested-By'] = 'cli';
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers });
    const body = await res.json();
    console.log(JSON.stringify(body, null, 2));
    if (!res.ok) process.exitCode = 1;
  } catch {
    console.error(`Failed to connect to daemon on port ${port}. Is it running?`);
    process.exitCode = 1;
  }
}
