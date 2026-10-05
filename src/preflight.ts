/** Boot checks only — no Jira, no model, no writes. Safe to run as often as you like. */
import { readModelCredential } from '@src/agent/credential';
import { readGitHubToken } from '@src/vcs/envToken';
import { budgetOf, loadWorkerConfig } from '@common/workerConfig';

try {
  const cred = readModelCredential(process.env);
  console.log(`model credential  ok — mode '${cred.mode}', from ${cred.source} (${cred.value.length} chars)`);

  readGitHubToken(process.env);
  console.log('github token      ok');

  const config = loadWorkerConfig();
  console.log('worker config     ok —', {
    mcpUrl: config.mcpUrl,
    bot: config.bot,
    workspaceRoot: config.workspaceRoot,
    ...budgetOf(config).ticket,
    maxTicketsPerDay: budgetOf(config).maxTicketsPerDay,
  });
  console.log('\nready. nothing was claimed and nothing was spent.');
} catch (error) {
  console.error('NOT ready:', (error as Error).message);
  process.exit(1);
}
