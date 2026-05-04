import { fileURLToPath } from 'node:url';
import { loadConciergeConfig, type ConciergeConfig } from '../core/config.js';
import {
  defaultConciergeStateDbPath,
  openConciergeStateDatabase,
  type ConciergeStateDatabase,
} from './node-sqlite.js';
import { applyConciergeStateSchemaMigrations } from './state-schema.js';
import {
  createDailyActivityConsolidator,
  createDailySummaryFileWriter,
  type DailyActivityConsolidationResult,
  type DailySummaryWriter,
} from './consolidator.js';

export interface StartDailyActivityConsolidatorProcessOptions {
  loadConfig?: () => Promise<ConciergeConfig>;
  stateDbPath?: string;
  openStateDatabase?: (path: string) => ConciergeStateDatabase;
  createWriter?: (config: ConciergeConfig) => DailySummaryWriter;
  now?: () => number;
  logger?: Pick<Console, 'log' | 'error'>;
}

export async function startDailyActivityConsolidatorProcess(
  options: StartDailyActivityConsolidatorProcessOptions = {},
): Promise<DailyActivityConsolidationResult> {
  const logger = options.logger ?? console;
  const config = await (options.loadConfig ?? loadConciergeConfig)();
  const stateDbPath = options.stateDbPath ?? defaultConciergeStateDbPath();
  const stateDb = (options.openStateDatabase ?? openConciergeStateDatabase)(stateDbPath);
  try {
    await applyConciergeStateSchemaMigrations(stateDb, stateDb);
    const writer = options.createWriter?.(config)
      ?? createDailySummaryFileWriter({ vaultPath: config.vaultPath });
    const result = await createDailyActivityConsolidator({
      db: stateDb,
      writer,
      now: options.now,
    }).runOnce();
    logger.log(`concierge consolidator wrote ${result.date}; pruned ${result.rawRecordsPruned} raw record(s)`);
    return result;
  } catch (error) {
    logger.error(error);
    throw error;
  } finally {
    stateDb.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void startDailyActivityConsolidatorProcess().catch(() => {
    process.exitCode = 1;
  });
}
