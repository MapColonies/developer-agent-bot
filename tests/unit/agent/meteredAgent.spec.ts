import { describe, expect, it } from 'vitest';
import { meterAgent, spendOf } from '@src/agent/meteredAgent';
import type { AgentPort, AgentRun, AgentRunRequest } from '@src/agent/types';
import { createBudgetGuard, type TicketGuard } from '@src/budget/guard';
import type { AbortPort, AbortResult, BudgetConfig } from '@src/budget/types';
import type { JiraTicket } from '@src/jira/types';
import type { HandBackOnce } from '@src/tickets/handBackOnce';
import { ticket } from '@tests/helpers/fakeJira';
import { fakeLogger, type RecordedLine } from '@tests/helpers/fakeLogger';

const WORKDIR = '/workspace/some-service';
const TICKET = ticket({ key: 'MAPCO-77' });

const request: AgentRunRequest = {
  task: { key: TICKET.key, summary: TICKET.summary, description: 'Make the retry actually retry.' },
  workdir: WORKDIR,
  maxTurns: 40,
};

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    outcome: 'changed',
    usage: { input: 100, output: 20, cacheRead: 5, costUsd: 0.5 },
    turns: 4,
    summary: 'edited the helper',
    deniedTools: [],
    ...overrides,
  };
}

/** Hands out queued runs and refuses to invent one, so a hand-off nobody expected fails loudly. */
function fakeAgent(runs: AgentRun[]): AgentPort & { requests: AgentRunRequest[] } {
  const requests: AgentRunRequest[] = [];
  const queue = [...runs];

  return {
    requests,
    run: async (asked: AgentRunRequest): Promise<AgentRun> => {
      requests.push(asked);
      const next = queue.shift();

      if (next === undefined) {
        throw new Error(`the agent was run more times than the spec queued (${requests.length})`);
      }

      return Promise.resolve(next);
    },
  };
}

/** Records every abort, which is how the spec sees whether the hand-back path was taken. */
function recordingAbort(): AbortPort & { notes: string[] } {
  const notes: string[] = [];

  return {
    notes,
    abort: async (_: JiraTicket, note: string): Promise<AbortResult> => {
      notes.push(note);

      return Promise.resolve({ released: true, attemptCounted: true });
    },
  };
}

/** The ticket's latch, recording only. What it is told is the whole seam worth asserting on. */
function recordingLatch(): Pick<HandBackOnce, 'record'> & { recorded: AbortResult[] } {
  const recorded: AbortResult[] = [];

  return { recorded, record: (outcome: AbortResult): void => void recorded.push(outcome) };
}

function budget(overrides: Partial<BudgetConfig['ticket']> = {}, maxTicketsPerDay = 5): BudgetConfig {
  return { ticket: { maxTokens: 1_000_000, maxTurns: 1_000, ...overrides }, maxTicketsPerDay };
}

interface Metered {
  readonly agent: AgentPort;
  readonly inner: AgentPort & { requests: AgentRunRequest[] };
  readonly abort: AbortPort & { notes: string[] };
  readonly handBack: Pick<HandBackOnce, 'record'> & { recorded: AbortResult[] };
  readonly meter: TicketGuard;
  readonly lines: RecordedLine[];
}

async function metered(runs: AgentRun[], config: BudgetConfig = budget()): Promise<Metered> {
  const { logger, lines } = fakeLogger();
  const abort = recordingAbort();
  const guard = createBudgetGuard({ budget: config, abort, logger });
  const started = await guard.cycle().start(TICKET, async () => Promise.resolve({ ok: true }));

  if (!started.ok) {
    throw new Error('the spec could not start a ticket');
  }

  const inner = fakeAgent(runs);
  const handBack = recordingLatch();

  return {
    agent: meterAgent({ agent: inner, meter: started.ticket, handBack, logger }),
    inner,
    abort,
    handBack,
    meter: started.ticket,
    lines,
  };
}

describe('spendOf', () => {
  it('should charge the whole prompt, cache reads included.', () => {
    // A cache read is a billed prompt token, and an agentic loop re-reads its context every
    // turn — leaving them out would put most of what a ticket costs outside the ceiling.
    expect(spendOf(run({ usage: { input: 100, output: 20, cacheRead: 5_000, costUsd: 1 }, turns: 9 }))).toStrictEqual({
      tokens: 5_120,
      turns: 9,
    });
  });

  it("should charge the hand-off's real turn count, not one per hand-off.", () => {
    // Charging 1 would turn a ceiling of forty turns into forty hand-offs of forty turns.
    expect(spendOf(run({ turns: 12 })).turns).toBe(12);
  });
});

describe('meterAgent', () => {
  it('should pass a run that is within budget straight through.', async () => {
    const { agent } = await metered([run()]);

    await expect(agent.run(request)).resolves.toMatchObject({ outcome: 'changed', summary: 'edited the helper' });
  });

  it('should hand the request to the real agent unchanged.', async () => {
    const { agent, inner } = await metered([run()]);

    await agent.run(request);

    expect(inner.requests).toStrictEqual([request]);
  });

  it('should charge every hand-off to the ticket, so the ceiling bites during it.', async () => {
    const { agent, meter } = await metered([run({ turns: 3 }), run({ turns: 4 })]);

    await agent.run(request);
    await agent.run(request);

    expect(meter.spend()).toStrictEqual({ tokens: 250, turns: 7 });
  });

  it('should report the run as over once the token ceiling is reached.', async () => {
    const { agent } = await metered([run()], budget({ maxTokens: 100 }));

    await expect(agent.run(request)).resolves.toMatchObject({ outcome: 'gave-up' });
  });

  it('should report the run as over once the turn ceiling is reached.', async () => {
    const { agent } = await metered([run({ turns: 50 })], budget({ maxTurns: 40 }));

    await expect(agent.run(request)).resolves.toMatchObject({ outcome: 'gave-up' });
  });

  it('should say what it spent and which ceiling it hit.', async () => {
    const { agent } = await metered([run({ turns: 50 })], budget({ maxTurns: 40 }));

    await expect(agent.run(request)).resolves.toMatchObject({ summary: expect.stringContaining('50 turns') as unknown as string });
  });

  it('should let the budget guard hand the ticket back, rather than doing it here.', async () => {
    // One release path, not two: the note comes from `describeOverspend` and the count from
    // `handBackTicket`, both behind `AbortPort`.
    const { agent, abort } = await metered([run()], budget({ maxTokens: 10 }));

    await agent.run(request);

    expect(abort.notes).toHaveLength(1);
    expect(abort.notes[0]).toContain('ran out of the budget');
  });

  it('should tell the ticket what the hand-offs managed, so the comment is worth reading.', async () => {
    const { agent, abort } = await metered([run({ outcome: 'changed' })], budget({ maxTokens: 10 }));

    await agent.run(request);

    expect(abort.notes[0]).toContain('hand-off 1: changed files in the clone');
    expect(abort.notes[0]).toContain('How far it got: a change in the clone, not yet verified');
  });

  it('should report a ticket that never got going as having reached nowhere.', async () => {
    const { agent, abort } = await metered([run({ outcome: 'no-change' })], budget({ maxTokens: 10 }));

    await agent.run(request);

    expect(abort.notes[0]).toContain('read the ticket and changed nothing');
    expect(abort.notes[0]).not.toContain('How far it got');
  });

  it('should throw away an unverified change rather than spend past the ceiling to publish it.', async () => {
    // The suite has not run at this point, so "it changed files" is not "it works", and
    // publishing would cost more of a budget that has already gone.
    const { agent } = await metered([run({ outcome: 'changed' })], budget({ maxTokens: 10 }));

    await expect(agent.run(request)).resolves.toMatchObject({ outcome: 'gave-up' });
  });

  it('should spend nothing more once the ticket has been stopped.', async () => {
    // The queue holds one run, so a second call reaching the real agent fails the spec rather
    // than quietly costing money.
    const { agent, abort } = await metered([run()], budget({ maxTokens: 10 }));

    await agent.run(request);

    await expect(agent.run(request)).resolves.toMatchObject({ outcome: 'gave-up' });
    expect(abort.notes).toHaveLength(1);
  });

  it("should tell the ticket's latch what the overspend hand-back achieved.", async () => {
    // The seam that stops one ticket being handed back twice: the abort has already commented,
    // counted and released, and the give-up that follows must write nothing.
    const { agent, handBack } = await metered([run()], budget({ maxTokens: 10 }));

    await agent.run(request);

    expect(handBack.recorded).toStrictEqual([{ released: true, attemptCounted: true }]);
  });

  it('should tell the latch nothing when the ticket was never stopped.', async () => {
    const { agent, handBack } = await metered([run()]);

    await agent.run(request);

    expect(handBack.recorded).toStrictEqual([]);
  });

  it('should let a transport failure through, because there is nothing to charge for it.', async () => {
    const { logger } = fakeLogger();
    const abort = recordingAbort();
    const guard = createBudgetGuard({ budget: budget(), abort, logger });
    const started = await guard.cycle().start(TICKET, async () => Promise.resolve({ ok: true }));

    if (!started.ok) {
      throw new Error('the spec could not start a ticket');
    }

    const exploding: AgentPort = { run: async (): Promise<AgentRun> => Promise.reject(new Error('the api fell over')) };
    const agent = meterAgent({ agent: exploding, meter: started.ticket, handBack: recordingLatch(), logger });

    await expect(agent.run(request)).rejects.toThrow('the api fell over');
    expect(started.ticket.spend()).toStrictEqual({ tokens: 0, turns: 0 });
  });
});
