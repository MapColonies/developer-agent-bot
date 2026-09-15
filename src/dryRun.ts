/**
 * One cycle against a real MCP server, on demand, from a laptop.
 *
 * Separate from `index.ts` on purpose: no scheduler, no tracing, and no
 * `@map-colonies/config` (which wants a config server this service has no schema on yet).
 * It exercises the same `runCycle` seam the deployed worker runs, so what it proves is
 * about the worker and not about the harness.
 *
 * **This is the whole pipeline now, not a claim and a release.** It claims a real ticket, clones
 * the repository its title names, hands the ticket to the model inside that clone, runs the
 * repository's own tests, and on a passing run pushes an `agent/` branch and opens a real pull
 * request. It costs real tokens against the configured key and it writes to real tickets. The
 * spend ceilings apply — `MAX_TICKETS_PER_DAY` counts per process, so a dry run gets its own
 * allowance — and the cheapest way to keep a first run small is to set them low on the command
 * line.
 */
import 'reflect-metadata';
import { jsLogger } from '@map-colonies/js-logger';
import { budgetOf, loadWorkerConfig } from '@common/workerConfig';
import { ATTEMPT_CAP, runCycle } from './cycle';
import { McpJira } from './jira/mcpJira';
import { buildPollQuery } from './jira/query';
import { createWorker } from './worker';

async function dryRun(): Promise<void> {
  const config = loadWorkerConfig();
  const logger = await jsLogger({ level: 'debug', prettyPrint: true });

  logger.info({
    msg: 'dry run starting',
    mcpUrl: config.mcpUrl,
    jql: buildPollQuery(ATTEMPT_CAP),
    workspaceRoot: config.workspaceRoot,
    ...budgetOf(config).ticket,
    maxTicketsPerDay: budgetOf(config).maxTicketsPerDay,
  });

  const jira = new McpJira(config.mcpUrl);

  try {
    const result = await runCycle(createWorker({ jira, logger, config }));
    logger.info({ msg: 'dry run complete', ...result });
  } finally {
    await jira.close();
  }
}

void dryRun().catch((error: Error) => {
  console.error('dry run failed');
  console.error(error);
  process.exit(1);
});
