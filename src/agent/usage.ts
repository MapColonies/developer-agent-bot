import type { TokenUsage } from './types';

/** What a run costs before it has cost anything. */
const NO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, costUsd: 0 };

/**
 * Add two runs' usage together.
 *
 * Attempts are separate runs with separate bills, so a ticket's cost is the sum of them — the
 * number a human wants when asking what the worker spent on a ticket it then handed back.
 */
function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    costUsd: left.costUsd + right.costUsd,
  };
}

export { addUsage, NO_USAGE };
