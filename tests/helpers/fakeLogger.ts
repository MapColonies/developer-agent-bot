import type { Logger } from '@map-colonies/js-logger';
import { vi } from 'vitest';

export interface RecordedLine {
  level: 'info' | 'warn' | 'error';
  payload: Record<string, unknown>;
}

export function fakeLogger(): { logger: Logger; lines: RecordedLine[] } {
  const lines: RecordedLine[] = [];

  const record =
    (level: RecordedLine['level']) =>
    (payload: unknown): void => {
      lines.push({ level, payload: payload as Record<string, unknown> });
    };

  const logger = {
    info: record('info'),
    error: record('error'),
    warn: record('warn'),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  return { logger, lines };
}
