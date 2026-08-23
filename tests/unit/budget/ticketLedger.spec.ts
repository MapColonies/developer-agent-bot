import { describe, expect, it } from 'vitest';
import { createTicketLedger } from '@src/budget/ticketLedger';

describe('createTicketLedger', () => {
  it('should let a ticket carry on while both halves of its budget have room.', () => {
    const ledger = createTicketLedger({ maxTokens: 1000, maxTurns: 5 });

    expect(ledger.charge({ tokens: 100, turns: 1 })).toEqual({ ok: true, spend: { tokens: 100, turns: 1 } });
    expect(ledger.charge({ tokens: 150, turns: 1 })).toEqual({ ok: true, spend: { tokens: 250, turns: 2 } });
  });

  it('should stop the ticket on the turn that used up its tokens, and report what it really cost.', () => {
    const ledger = createTicketLedger({ maxTokens: 1000, maxTurns: 100 });

    ledger.charge({ tokens: 600, turns: 1 });

    // The turn is charged before the verdict, so the total is over the limit. That is the
    // honest number: a metered API only says what a turn cost once it has already cost it, and
    // the comment on the ticket must report what was billed rather than a tidier figure.
    expect(ledger.charge({ tokens: 700, turns: 1 })).toEqual({
      ok: false,
      kind: 'tokens',
      limit: 1000,
      spend: { tokens: 1300, turns: 2 },
      alreadyStopped: false,
    });
  });

  it('should treat a budget spent exactly to its limit as spent.', () => {
    const ledger = createTicketLedger({ maxTokens: 1000, maxTurns: 100 });

    // Nothing left to spend means no further turn, even though this one did not go over.
    expect(ledger.charge({ tokens: 1000, turns: 1 })).toEqual({
      ok: false,
      kind: 'tokens',
      limit: 1000,
      spend: { tokens: 1000, turns: 1 },
      alreadyStopped: false,
    });
  });

  it('should stop the ticket on its last allowed turn however cheap the turns were.', () => {
    const ledger = createTicketLedger({ maxTokens: 1_000_000, maxTurns: 3 });

    // The failure this half exists for: a loop that burns turns on calls too cheap to ever
    // trip the token ceiling.
    expect(ledger.charge({ tokens: 1, turns: 1 }).ok).toBe(true);
    expect(ledger.charge({ tokens: 1, turns: 1 }).ok).toBe(true);
    expect(ledger.charge({ tokens: 1, turns: 1 })).toEqual({
      ok: false,
      kind: 'turns',
      limit: 3,
      spend: { tokens: 3, turns: 3 },
      alreadyStopped: false,
    });
  });

  it('should report a turn overrun when one turn uses up both halves at once.', () => {
    const ledger = createTicketLedger({ maxTokens: 10, maxTurns: 1 });

    // A documented tie-break, not an accident: the turn count is the bound on looping, and a
    // loop wants a human looking at the agent rather than at the token knob.
    expect(ledger.charge({ tokens: 500, turns: 1 })).toEqual({
      ok: false,
      kind: 'turns',
      limit: 1,
      spend: { tokens: 500, turns: 1 },
      alreadyStopped: false,
    });
  });

  it('should keep answering for the spend after the budget is gone, since the comment needs it.', () => {
    const ledger = createTicketLedger({ maxTokens: 10, maxTurns: 10 });

    ledger.charge({ tokens: 50, turns: 1 });
    ledger.charge({ tokens: 50, turns: 1 });

    expect(ledger.spend()).toStrictEqual({ tokens: 100, turns: 2 });
  });

  it('should latch its refusal, so only the first charge past the ceiling is a new one.', () => {
    const ledger = createTicketLedger({ maxTokens: 100, maxTurns: 10 });

    // The first refusal is the one that hands the ticket back. Anything charged after it — a
    // turn already in flight, or a caller that read a failed hand-back as retryable — must not
    // read as a fresh overrun, or the ticket gets a second comment and a second release.
    expect(ledger.charge({ tokens: 150, turns: 1 })).toMatchObject({ ok: false, alreadyStopped: false });
    expect(ledger.charge({ tokens: 150, turns: 1 })).toMatchObject({ ok: false, alreadyStopped: true });
    expect(ledger.charge({ tokens: 1, turns: 1 })).toMatchObject({ ok: false, alreadyStopped: true });
  });

  it('should keep reporting the ceiling it first stopped on, not whichever one it is furthest past.', () => {
    const ledger = createTicketLedger({ maxTokens: 1_000_000, maxTurns: 2 });

    ledger.charge({ tokens: 1, turns: 1 });

    // It ran out of turns; charging on will eventually pass the token ceiling too. The reason
    // the ticket stopped is still "turns", and the comment already sent said so.
    expect(ledger.charge({ tokens: 2_000_000, turns: 1 })).toMatchObject({ kind: 'turns', limit: 2, alreadyStopped: false });
    expect(ledger.charge({ tokens: 2_000_000, turns: 1 })).toMatchObject({ kind: 'turns', limit: 2, alreadyStopped: true });
  });

  it('should still bill the turns charged after it refused, since they cost real money.', () => {
    const ledger = createTicketLedger({ maxTokens: 100, maxTurns: 10 });

    ledger.charge({ tokens: 150, turns: 1 });
    ledger.charge({ tokens: 400, turns: 1 });

    // Latching stops a second hand-back, not the accounting. The run line and the ticket must
    // report what was actually billed rather than the total as of the refusal.
    expect(ledger.spend()).toStrictEqual({ tokens: 550, turns: 2 });
  });

  it('should count the turns it is told about rather than one per charge.', () => {
    const ledger = createTicketLedger({ maxTokens: 1_000_000, maxTurns: 40 });

    // The defect this shape exists to prevent. The only spend source in the repo reports usage
    // once per hand-off, so a caller charges a whole hand-off at a time. If the ledger added a
    // turn per call instead of taking the count, a ceiling of 40 turns would have permitted 40
    // hand-offs of up to 40 turns each — roughly 1,600 model turns against a limit named 40.
    expect(ledger.charge({ tokens: 5000, turns: 38 })).toMatchObject({ ok: true, spend: { tokens: 5000, turns: 38 } });
    expect(ledger.charge({ tokens: 5000, turns: 4 })).toEqual({
      ok: false,
      kind: 'turns',
      limit: 40,
      spend: { tokens: 10_000, turns: 42 },
      alreadyStopped: false,
    });
  });

  it('should stop a ticket whose very first hand-off overran the whole turn ceiling.', () => {
    const ledger = createTicketLedger({ maxTokens: 1_000_000, maxTurns: 8 });

    // An operator ramping cautiously sets MAX_TURNS_PER_TICKET=8 while the agent's own per-run
    // turn bound is still higher. The overshoot is reported rather than clamped: 12 turns were
    // billed, and the comment on the ticket has to say 12.
    expect(ledger.charge({ tokens: 900, turns: 12 })).toEqual({
      ok: false,
      kind: 'turns',
      limit: 8,
      spend: { tokens: 900, turns: 12 },
      alreadyStopped: false,
    });
  });

  it('should bill a ticket for its own work only.', () => {
    const budget = { maxTokens: 1000, maxTurns: 10 };
    const first = createTicketLedger(budget);
    const second = createTicketLedger(budget);

    first.charge({ tokens: 900, turns: 1 });

    // Cost landing on the ticket that caused it is the whole point of the slice; a ledger
    // shared between tickets would charge the second one for the first one's overrun.
    expect(second.charge({ tokens: 50, turns: 1 })).toEqual({ ok: true, spend: { tokens: 50, turns: 1 } });
  });
});
