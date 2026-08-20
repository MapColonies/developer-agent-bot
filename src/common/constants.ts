import { readPackageJsonSync } from '@map-colonies/read-pkg';

export const SERVICE_NAME = readPackageJsonSync().name ?? 'unknown_service';

export const IGNORED_OUTGOING_TRACE_ROUTES = [/^.*\/v1\/metrics.*$/];
export const IGNORED_INCOMING_TRACE_ROUTES: RegExp[] = [];

/**
 * Label vocabulary the pipeline keys off. Settled in MAPCO-11427.
 *
 * `AGENT_READY` is the enrolment: a human puts it on a ticket to say a machine may take it.
 * Availability is a separate thing entirely — it is the ticket being unassigned.
 */
export const LABELS = {
  agentReady: 'agent-ready',
  /** Attempt counter, carried as `agent-attempted-{n}`. Jira labels are the only store. */
  attemptedPrefix: 'agent-attempted-',
} as const;

/**
 * Status *names* that mean the ticket is finished.
 *
 * Deliberately not `statusCategory = Done`: verified against the live instance in
 * MAPCO-11427, `Resolved` reports category `In Progress`, so a category filter would
 * hand the worker already-finished tickets.
 */
export const TERMINAL_STATUS_NAMES = ['Resolved', 'Closed', 'Done', 'Verified', 'Canceled', 'Rejected'] as const;

/* eslint-disable @typescript-eslint/naming-convention */
export const SERVICES = {
  LOGGER: Symbol('Logger'),
  CONFIG: Symbol('Config'),
  TRACER: Symbol('Tracer'),
  METRICS: Symbol('METRICS'),
  JIRA: Symbol('Jira'),
  WORKER_CONFIG: Symbol('WorkerConfig'),
} satisfies Record<string, symbol>;
/* eslint-enable @typescript-eslint/naming-convention */
