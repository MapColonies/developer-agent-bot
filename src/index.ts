// this import must be called before the first import of tsyringe
import 'reflect-metadata';
import type { Logger } from '@map-colonies/js-logger';
import { SERVICES } from '@common/constants';
import { loadWorkerConfig } from '@common/workerConfig';
import { getTracing } from '@common/tracing';
import { registerExternalValues } from './containerConfig';
import { McpJira } from './jira/mcpJira';
import { createScheduler } from './scheduler';

async function main(): Promise<void> {
  const container = await registerExternalValues();
  const logger = container.resolve<Logger>(SERVICES.LOGGER);
  const config = loadWorkerConfig();

  const jira = new McpJira(config.mcpUrl);
  const scheduler = createScheduler({ jira, logger, config }, config.pollIntervalMs, logger);

  const shutdown = (signal: string): void => {
    logger.info({ msg: 'shutting down', signal });
    void scheduler
      .stop()
      .then(async () => Promise.all([jira.close(), getTracing().stop()]))
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  scheduler.start();
}

void main().catch((error: Error) => {
  console.error('😢 - failed initializing the worker');
  console.error(error);
  process.exit(1);
});
