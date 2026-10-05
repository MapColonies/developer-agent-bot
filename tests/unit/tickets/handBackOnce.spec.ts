import { describe, expect, it } from 'vitest';
import { createHandBackOnce, type HandBackOnce } from '@src/tickets/handBackOnce';
import { FakeJira, ticket, type FakeWrite } from '@tests/helpers/fakeJira';
import { fakeLogger } from '@tests/helpers/fakeLogger';

const ATTEMPT_CAP = 2;
const GIVE_UP_NOTE = 'Picked this up automatically and could not finish it.';

const workflow = {
  'MAPCO-1': [
    { id: '21', name: 'Start Progress', to: 'In Progress' },
    { id: '11', name: 'Reopen', to: 'Open' },
  ],
};

/** A workflow with no route back to Open, which is what makes a hand-back keep hold of a ticket. */
const stuck = { 'MAPCO-1': [{ id: '21', name: 'Start Progress', to: 'In Progress' }] };

function comments(writes: readonly FakeWrite[]): string[] {
  return writes.filter((write) => write.kind === 'comment').map((write) => write.body);
}

function handBackFor(jira: FakeJira): HandBackOnce {
  return createHandBackOnce({ jira, logger: fakeLogger().logger, attemptCap: ATTEMPT_CAP });
}

describe('createHandBackOnce', () => {
  it('should hand the ticket back the first time it is asked.', async () => {
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflow });

    await expect(handBackFor(jira).handBack(ticket(), GIVE_UP_NOTE)).resolves.toStrictEqual({ ok: true });

    expect(jira.writes.map((write) => write.kind)).toStrictEqual(['labels', 'comment', 'transition', 'assign']);
  });

  it('should write nothing more once the budget path has handed the ticket back.', async () => {
    // The ordinary overspend: the budget guard aborts mid-hand-off, and the run that is now over
    // is reported to `implementTicket` as a give-up, which hands the ticket back as well. A
    // second pass would comment again on a ticket already in Open that a human may have taken.
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflow });
    const handBack = handBackFor(jira);

    handBack.record({ released: true, attemptCounted: true });

    await expect(handBack.handBack(ticket(), GIVE_UP_NOTE)).resolves.toStrictEqual({ ok: true });
    expect(jira.writes).toStrictEqual([]);
  });

  it('should report what the budget path achieved rather than inventing a release.', async () => {
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflow });
    const handBack = handBackFor(jira);

    handBack.record({ released: false, attemptCounted: true });

    // Counted but still held: the ticket is not available, and a caller that read this as a
    // release would report a ticket as back in Open when it is assigned to the bot.
    await expect(handBack.handBack(ticket(), GIVE_UP_NOTE)).resolves.toMatchObject({ ok: false });
  });

  it('should still hand the ticket back when the budget path wrote nothing at all.', async () => {
    // `attemptCounted: false` means `handBackTicket` refused before the first write — no label,
    // no comment, no transition. Latching on that would leave the ticket held and silent, with a
    // worker that had decided it was finished with it.
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflow });
    const handBack = handBackFor(jira);

    handBack.record({ released: false, attemptCounted: false });

    await expect(handBack.handBack(ticket(), GIVE_UP_NOTE)).resolves.toStrictEqual({ ok: true });
    expect(comments(jira.writes)).toStrictEqual([GIVE_UP_NOTE]);
  });

  it('should collapse two callers racing into one write.', async () => {
    // The latch is taken before the first await, so a second caller joins the first's promise
    // rather than starting a hand-back of its own.
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflow });
    const handBack = handBackFor(jira);

    await Promise.all([handBack.handBack(ticket(), GIVE_UP_NOTE), handBack.handBack(ticket(), GIVE_UP_NOTE)]);

    expect(comments(jira.writes)).toHaveLength(1);
  });

  it('should report a hand-back that could not release, without pretending it did.', async () => {
    const jira = new FakeJira({ tickets: [ticket()], transitions: stuck });

    await expect(handBackFor(jira).handBack(ticket(), GIVE_UP_NOTE)).resolves.toMatchObject({ ok: false, reason: 'no-transition' });
  });

  it('should not retry a hand-back that failed, because the counter is already written.', async () => {
    // The attempt counter landed and the release did not. Trying again would comment a second
    // time on a ticket the worker still holds, and the boot-time orphan sweep is what recovers it.
    const jira = new FakeJira({ tickets: [ticket()], transitions: stuck });
    const handBack = handBackFor(jira);

    await handBack.handBack(ticket(), GIVE_UP_NOTE);
    await handBack.handBack(ticket(), GIVE_UP_NOTE);

    expect(comments(jira.writes)).toHaveLength(1);
  });

  it('should say whether the ticket has been handed back.', async () => {
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflow });
    const handBack = handBackFor(jira);

    expect(handBack.handedBack()).toBe(false);

    await handBack.handBack(ticket(), GIVE_UP_NOTE);

    expect(handBack.handedBack()).toBe(true);
  });
});
