import { describe, expect, it } from 'vitest';
import { claimTicket, releaseTicket } from '@src/tickets/claim';
import { FakeJira, ticket } from '@tests/helpers/fakeJira';
import type { BotIdentity } from '@src/tickets/claim';

/**
 * The two halves of the bot's identity. They differ on purpose: a write takes an
 * identifier, a read comes back as a surname-first display name.
 */
const BOT_ACCOUNT = 'developer-agent@mapcolonies.example';
const BOT_DISPLAY_NAME = 'AGENT DEVELOPER';

const bot: BotIdentity = { account: BOT_ACCOUNT, displayName: BOT_DISPLAY_NAME };
const displayNames = { [BOT_ACCOUNT]: BOT_DISPLAY_NAME };

/** A realistic workflow: transitions named as verbs, each reporting the status it lands in. */
const workflow = {
  'MAPCO-1': [
    { id: '21', name: 'Start Progress', to: 'In Progress' },
    { id: '11', name: 'Reopen', to: 'Open' },
  ],
};

describe('claimTicket', () => {
  it('should claim a ready ticket by assigning the bot and moving it to In Progress.', async () => {
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflow, displayNames });

    const outcome = await claimTicket(ticket(), jira, bot);

    expect(outcome).toEqual({ ok: true });
    expect(jira.writes).toEqual([
      { kind: 'assign', key: 'MAPCO-1', assignee: BOT_ACCOUNT },
      { kind: 'transition', key: 'MAPCO-1', transitionId: '21' },
    ]);
  });

  it('should find the transition by the status it lands in, not by its own name.', async () => {
    // The real reason this matters: a workflow whose transitions are verbs would otherwise
    // never match, and every claim would refuse for a reason that looks like a workflow
    // problem rather than a bug here.
    const jira = new FakeJira({
      tickets: [ticket()],
      transitions: { 'MAPCO-1': [{ id: '77', name: 'Begin working on this', to: 'In Progress' }] },
      displayNames,
    });

    await expect(claimTicket(ticket(), jira, bot)).resolves.toEqual({ ok: true });
    expect(jira.writes).toContainEqual({ kind: 'transition', key: 'MAPCO-1', transitionId: '77' });
  });

  it('should still match on the transition name when the server reports no target status.', async () => {
    const jira = new FakeJira({ tickets: [ticket()], transitions: { 'MAPCO-1': [{ id: '21', name: 'In Progress' }] }, displayNames });

    await expect(claimTicket(ticket(), jira, bot)).resolves.toEqual({ ok: true });
  });

  it('should never pick up a ticket someone already holds, and write nothing at all.', async () => {
    const held = ticket({ assignee: 'BROCHSTEIN RAZ' });
    const jira = new FakeJira({ tickets: [held], transitions: workflow, displayNames });

    const outcome = await claimTicket(held, jira, bot);

    expect(outcome).toEqual({ ok: false, reason: 'already-assigned' });
    expect(jira.writes).toEqual([]);
  });

  it('should back off when the re-read shows a human got there first, writing nothing further.', async () => {
    const jira = new FakeJira({ tickets: [ticket()], transitions: workflow, displayNames, stealOnAssign: 'BROCHSTEIN RAZ' });

    const outcome = await claimTicket(ticket(), jira, bot);

    // `saw` is what makes a misconfigured JIRA_BOT_DISPLAY_NAME tell itself apart from a
    // genuine race: the same refusal, but the name in it is the bot's own.
    expect(outcome).toEqual({ ok: false, reason: 'lost-race', saw: 'BROCHSTEIN RAZ' });
    // The assignee write is already out there and is not ours to undo — the human owns the
    // field now, so unwinding it would take the ticket off them.
    expect(jira.writes).toEqual([{ kind: 'assign', key: 'MAPCO-1', assignee: BOT_ACCOUNT }]);
  });

  it('should treat a ticket that vanished between the write and the re-read as lost.', async () => {
    const jira = new FakeJira({ transitions: workflow, displayNames });

    await expect(claimTicket(ticket(), jira, bot)).resolves.toEqual({ ok: false, reason: 'lost-race', saw: null });
  });

  it('should refuse before writing when the workflow offers no way into In Progress.', async () => {
    const jira = new FakeJira({ tickets: [ticket()], transitions: { 'MAPCO-1': [{ id: '31', name: 'Reject', to: 'Rejected' }] }, displayNames });

    const outcome = await claimTicket(ticket(), jira, bot);

    // The offered names are reported so the first run against a real workflow says what it
    // was actually given, instead of refusing every ticket in silence.
    expect(outcome).toEqual({ ok: false, reason: 'no-transition', offered: ['Reject'] });
    // Looked before it leapt: refusing after the assign would leave a ticket held by a bot
    // that cannot start it.
    expect(jira.writes).toEqual([]);
  });
});

describe('releaseTicket', () => {
  const held = (): ReturnType<typeof ticket> => ticket({ assignee: BOT_DISPLAY_NAME, status: 'In Progress' });

  it('should hand a ticket back by commenting, returning it to Open, then unassigning.', async () => {
    const jira = new FakeJira({ tickets: [held()], transitions: workflow, displayNames });

    const outcome = await releaseTicket(held(), 'Tried nothing, and it did not work.', jira);

    expect(outcome).toEqual({ ok: true });
    // Order is the whole design: unassigning last means a failure part-way through leaves
    // the ticket held by the bot — invisible to the poll query — rather than unassigned and
    // still In Progress, which the query would happily hand straight back.
    expect(jira.writes).toEqual([
      { kind: 'comment', key: 'MAPCO-1', body: 'Tried nothing, and it did not work.' },
      { kind: 'transition', key: 'MAPCO-1', transitionId: '11' },
      { kind: 'assign', key: 'MAPCO-1', assignee: null },
    ]);
  });

  it('should keep holding a ticket it cannot return to Open, rather than unassigning it into a re-claim loop.', async () => {
    const jira = new FakeJira({ tickets: [held()], transitions: { 'MAPCO-1': [{ id: '31', name: 'Reject', to: 'Rejected' }] }, displayNames });

    const outcome = await releaseTicket(held(), 'Tried nothing.', jira);

    expect(outcome).toEqual({ ok: false, reason: 'no-transition', offered: ['Reject'] });
    // Still the bot's problem, which is what makes the orphan sweep on boot able to find it.
    expect(jira.writes.some((write) => write.kind === 'assign')).toBe(false);
  });
});
