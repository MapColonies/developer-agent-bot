import { describe, expect, it } from 'vitest';
import { budgetRunLine, describeOverspend } from '@src/budget/report';
import type { AttemptSummary } from '@src/budget/types';

const attempt: AttemptSummary = {
  tried: ['resolved raster-shared from the title', 'cloned it and read the failing test'],
  reached: 'branch pushed, no pull request',
};

describe('describeOverspend', () => {
  it('should say what the ticket cost, which ceiling it hit and which knob to turn.', () => {
    const comment = describeOverspend({ kind: 'tokens', limit: 200_000, spend: { tokens: 212_431, turns: 12 }, attempt });

    // The spend is in the comment because the comment is where cost becomes attributable —
    // there is no dashboard, so a ticket that does not say what it cost costs nothing visible.
    expect(comment).toContain('12 turns and 212,431 tokens');
    expect(comment).toContain('200,000 tokens per ticket');
    expect(comment).toContain('MAX_TOKENS_PER_TICKET');
    expect(comment).toContain('- resolved raster-shared from the title');
    expect(comment).toContain('branch pushed, no pull request');
  });

  it('should name the turn knob when it was the turns that ran out.', () => {
    const comment = describeOverspend({ kind: 'turns', limit: 40, spend: { tokens: 6100, turns: 40 }, attempt });

    // Pointing at the token knob here would send a reader to raise a limit that was never the
    // one that stopped the ticket.
    expect(comment).toContain('40 turns per ticket');
    expect(comment).toContain('MAX_TURNS_PER_TICKET');
    expect(comment).not.toContain('MAX_TOKENS_PER_TICKET');
  });

  it('should say so plainly when the budget went before the ticket was even started.', () => {
    const comment = describeOverspend({ kind: 'turns', limit: 1, spend: { tokens: 900, turns: 1 }, attempt: { tried: [], reached: null } });

    expect(comment).toContain('never got as far as trying anything');
    expect(comment).not.toContain('How far it got');
  });

  it('should say it is handing the ticket back without claiming the attempt was counted.', () => {
    const comment = describeOverspend({ kind: 'tokens', limit: 200_000, spend: { tokens: 212_431, turns: 12 }, attempt });

    // Bumping `agent-attempted-N` needs a label write nothing in the worker has yet
    // (MAPCO-11432). A comment claiming the attempt was counted would tell whoever reads it
    // that the ticket is safe from being picked up and re-burnt, when it is the opposite.
    expect(comment).toContain('Handing the ticket back.');
    expect(comment).not.toContain('attempt');
  });

  it('should group its numbers the same way whatever locale the pod happens to have.', () => {
    const comment = describeOverspend({ kind: 'tokens', limit: 1_000_000, spend: { tokens: 1_234_567, turns: 3 }, attempt });

    // Pinned to one locale on purpose: the same overspend must not read as 1,234,567 on one
    // worker and 1.234.567 on the next.
    expect(comment).toContain('1,234,567 tokens');
  });
});

describe('budgetRunLine', () => {
  it('should carry the run cost under the tokensSpent key the run line already has.', () => {
    const line = budgetRunLine({ tokens: 900, turns: 3 }, { startedToday: 2, limit: 5, exhausted: false });

    expect(line).toStrictEqual({ tokensSpent: 900, turnsSpent: 3, ticketsStartedToday: 2, dailyCapLimit: 5, dailyCapReached: false });
  });

  it('should let a run that started nothing say why in one field.', () => {
    const line = budgetRunLine({ tokens: 0, turns: 0 }, { startedToday: 5, limit: 5, exhausted: true });

    // The run line is the only alarm this service has (MAPCO-11437), so "polled and started
    // nothing on purpose" has to be readable from it rather than inferred from a zero.
    expect(line).toMatchObject({ tokensSpent: 0, dailyCapReached: true, ticketsStartedToday: 5 });
  });
});
