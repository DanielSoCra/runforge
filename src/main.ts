import { createCli } from './control-plane/cli.js';
import { startDaemon } from './control-plane/daemon.js';

const cli = createCli();

// Wire the start command to actually launch the daemon
const startCmd = cli.commands.find((c) => c.name() === 'start');
if (startCmd) {
  startCmd.action(async (options: { config: string }) => {
    const result = await startDaemon(options.config);
    if (!result.ok) {
      console.error(`Failed to start: ${result.error.message}`);
      process.exit(1);
    }
  });
}

cli.parse();
