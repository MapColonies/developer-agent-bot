import { LABELS, TERMINAL_STATUS_NAMES } from '@common/constants';

/**
 * The poll query, verified against the live server in MAPCO-11427.
 *
 * Three things here are not obvious and each one was wrong in the first draft:
 *
 * 1. Finished work is excluded by status *name*. `statusCategory != Done` looks right and
 *    is not — `Resolved` reports category `In Progress` in this instance.
 * 2. The attempt-cap exclusion uses a bare `labels not in (...)`, which normally also
 *    excludes issues with no labels at all. That is safe *only* because `labels =
 *    agent-ready` already guarantees a non-empty label set. Any query that drops the
 *    agent-ready clause must add `labels is EMPTY OR ...` back.
 * 3. No `project = MAPCO` clause. The MCP server auto-bounds the query, wrapping it as
 *    `(<ours>) AND project = MAPCO`, so top-level `OR` is safe.
 */
export function buildPollQuery(attemptCap: number): string {
  // Only the label at the cap excludes a ticket. A ticket carrying `agent-attempted-1`
  // under a cap of 2 has one give-up behind it and is still fair game.
  const cappedLabel = `"${LABELS.attemptedPrefix}${attemptCap}"`;

  const clauses = [
    `labels = "${LABELS.agentReady}"`,
    'assignee is EMPTY',
    `status not in (${TERMINAL_STATUS_NAMES.join(', ')})`,
    `labels not in (${cappedLabel})`,
  ];

  return `${clauses.join(' AND ')} ORDER BY created ASC`;
}
