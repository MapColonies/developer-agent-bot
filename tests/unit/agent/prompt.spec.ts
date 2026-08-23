import { describe, expect, it } from 'vitest';
import { AGENT_GUARDRAILS, buildFailureReport, buildTaskPrompt } from '@src/agent/prompt';
import type { AgentRunRequest } from '@src/agent/types';

const request: AgentRunRequest = {
  task: { key: 'MAPCO-11434', summary: 'raster-shared: add a retry to the fetch helper', description: 'The helper gives up on the first 503.' },
  workdir: '/workspace/raster-shared',
  maxTurns: 40,
};

describe('buildTaskPrompt', () => {
  it('should hand over the ticket as the human wrote it, and the clone it is about.', () => {
    const prompt = buildTaskPrompt(request);

    expect(prompt).toContain('MAPCO-11434');
    expect(prompt).toContain('raster-shared: add a retry to the fetch helper');
    expect(prompt).toContain('The helper gives up on the first 503.');
    expect(prompt).toContain('/workspace/raster-shared');
  });

  it('should say nothing about a previous attempt on the first one.', () => {
    expect(buildTaskPrompt(request)).not.toContain('Previous attempt');
  });

  it('should carry the previous failure verbatim into a retry.', () => {
    // The whole point of a second attempt is the failure; a retry that did not include it
    // would be the same run again at the same price.
    const prompt = buildTaskPrompt({ ...request, previousFailure: 'AssertionError: expected 2 retries, got 1' });

    expect(prompt).toContain('Previous attempt');
    expect(prompt).toContain('AssertionError: expected 2 retries, got 1');
  });

  it('should admit when a ticket has no description rather than inventing one.', () => {
    const prompt = buildTaskPrompt({ ...request, task: { ...request.task, description: '   ' } });

    expect(prompt).toContain('no description');
  });
});

describe('buildFailureReport', () => {
  it('should name the command that failed and quote what it said.', () => {
    const report = buildFailureReport('npm run test:unit', '\n FAIL tests/retry.spec.ts \n');

    expect(report).toContain('npm run test:unit');
    expect(report).toContain('FAIL tests/retry.spec.ts');
  });

  it('should still read sensibly when there was no command to name.', () => {
    expect(buildFailureReport(null, 'no test command')).toContain('the test command');
  });
});

describe('AGENT_GUARDRAILS', () => {
  it('should tell the model the tools are absent rather than merely forbidden.', () => {
    // This text is not the control — the tool list is. It is here so the model does not spend
    // its turns planning around a shell it will never be given.
    expect(AGENT_GUARDRAILS).toContain('no shell');
    expect(AGENT_GUARDRAILS).toContain('no git');
  });

  it('should forbid weakening a test to get a pass, which is the one failure the suite cannot catch.', () => {
    expect(AGENT_GUARDRAILS).toContain('Never weaken, skip or delete a test');
  });

  it('should say that no one is there to answer a question.', () => {
    expect(AGENT_GUARDRAILS).toContain('no human in this session');
  });
});
