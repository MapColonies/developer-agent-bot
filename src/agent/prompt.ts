import type { AgentRunRequest } from './types';

/**
 * Appended to the SDK's own coding system prompt.
 *
 * None of this is a security control — the tool list is (see `buildAgentOptions`), and a
 * sentence asking the model not to use git would be worth nothing next to it. What this is
 * for is stopping the model from *planning around* tools it does not have: a model that
 * believes it can commit spends its turns trying to, reports work it did not do, and asks a
 * question no one is there to answer.
 *
 * The last rule is the one with teeth. The worker judges the change by the repository's own
 * suite, so weakening the suite is the shortest path to a pass and the one thing the check
 * cannot catch by itself.
 */
const AGENT_GUARDRAILS = [
  'You are running inside an automated worker. There is no human in this session: nothing can answer a question, approve a plan, or unblock you.',
  '',
  'You have file tools only — read, search, write, edit. You have no shell, no git, no GitHub and no network tools. They are absent from your tool list, not merely discouraged, so do not plan around them and do not report work that would need them.',
  '',
  "Do not commit, do not create a branch, and do not push. That is the worker's job after your change passes, and it is a later step you are not part of.",
  '',
  "You do not run the tests either. The worker runs the repository's own test suite after you stop, and if it fails you will be given the failure and asked again. Make the change you believe is right and stop; do not claim a suite passed.",
  '',
  'Work only inside the working directory you were given, and follow the conventions already in the repository over your own preferences.',
  '',
  'Never weaken, skip or delete a test to make the suite pass. If the ticket does not ask for a test change, a failing test means the change is wrong.',
].join('\n');

/**
 * The failure a retry is given, as the model sees it.
 *
 * Verbatim output, not a summary: the worker has no idea which line of a suite's output
 * matters, and paraphrasing it would throw away the stack trace that does.
 */
function buildFailureReport(command: string | null, output: string): string {
  return [`The previous attempt did not pass. \`${command ?? 'the test command'}\` reported:`, '', '```', output.trim(), '```'].join('\n');
}

/**
 * The ticket, as the task.
 *
 * Summary and description and nothing else invented on top: if a ticket is too thin for a
 * person to act on, the honest outcome is a failed attempt and a comment saying so, not a
 * worker that guesses what was meant.
 *
 * The empty-description branch is a floor, not a policy: `implementTicket` hands a ticket with
 * no prose back before it ever gets here, precisely so that no one pays for a hand-off to be
 * told what the ticket already said. It stays because this function is also called with
 * whatever a future caller has, and a prompt that silently omitted the task would be worse than
 * one that says there is none.
 */
function buildTaskPrompt(request: AgentRunRequest): string {
  const { task, previousFailure } = request;
  const parts = [
    `Implement Jira ticket ${task.key} in the repository checked out at ${request.workdir}.`,
    '',
    `## ${task.key}: ${task.summary}`,
    '',
    task.description.trim() === ''
      ? '_The ticket has no description. Work from the summary alone, or change nothing if it is not enough to act on._'
      : task.description.trim(),
  ];

  if (previousFailure !== undefined && previousFailure !== '') {
    parts.push('', '## Previous attempt', '', previousFailure);
  }

  return parts.join('\n');
}

export { AGENT_GUARDRAILS, buildFailureReport, buildTaskPrompt };
