/**
 * One cycle against a real MCP server, on demand, from a laptop.
 *
 * Separate from `index.ts` on purpose: no scheduler, no tracing, and no
 * `@map-colonies/config` (which wants a config server this service has no schema on yet).
 * It exercises the same `runCycle` seam the deployed worker runs, so what it proves is
 * about the worker and not about the harness.
 *
 * Not read-only: this walks the same claim-and-release path the deployed worker walks, so
 * it comments on, assigns and transitions a real ticket (MAPCO-11431).
 */
import 'reflect-metadata';
import { jsLogger } from '@map-colonies/js-logger';
import { loadWorkerConfig } from '@common/workerConfig';
import { ATTEMPT_CAP, runCycle } from './cycle';
import { McpJira } from './jira/mcpJira';
import { RestGitHub } from './github/restGitHub';
import { describeRefusal, resolveRepo } from './tickets/resolveRepo';
import { buildPollQuery } from './jira/query';

async function dryRun(): Promise<void> {
  const config = loadWorkerConfig();
  const logger = await jsLogger({ level: 'debug', prettyPrint: true });

  logger.info({ msg: 'dry run starting', mcpUrl: config.mcpUrl, jql: buildPollQuery(ATTEMPT_CAP) });

  const jira = new McpJira(config.mcpUrl);
  const github = new RestGitHub(process.env.GITHUB_TOKEN);

  try {
    const result = await runCycle({ jira, logger, config });
    logger.info({ msg: 'dry run complete', ...result });

    // Not part of the cycle yet — MAPCO-11433 wires it in. Shown here so a dry run
    // reports what the next slice would decide about each ticket it found.
    for (const ticket of await jira.search(buildPollQuery(ATTEMPT_CAP), config.maxTicketsPerRun)) {
      const resolution = await resolveRepo(ticket, github);

      if (resolution.ok) {
        logger.info({ msg: 'repo resolved', key: ticket.key, titleSaid: ticket.summary.split(':')[0], repo: resolution.repo });
      } else {
        logger.warn({ msg: 'would refuse', key: ticket.key, reason: resolution.reason, comment: describeRefusal(resolution) });
      }
    }
  } finally {
    await jira.close();
  }
}

void dryRun().catch((error: Error) => {
  console.error('dry run failed');
  console.error(error);
  process.exit(1);
});
