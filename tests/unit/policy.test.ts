import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/constants';
import { evaluateDecision } from '../../src/policy';
import type { ScoreReport } from '../../src/types';

function makeReport(score: number): ScoreReport {
  return {
    total: score,
    threshold: 7,
    heuristics: [],
    triggeredHeuristics: [],
    warnings: []
  };
}

describe('evaluateDecision', () => {
  it('allows PR when score is below threshold', () => {
    const result = evaluateDecision({ ...DEFAULT_CONFIG, dryRun: false }, makeReport(4), 'normal body');
    expect(result.decision).toBe('allow');
    expect(result.shouldComment).toBe(false);
  });

  it('flags PR in dry-run mode without side effects', () => {
    const result = evaluateDecision({ ...DEFAULT_CONFIG, dryRun: true }, makeReport(10), 'normal body');
    expect(result.decision).toBe('flagged');
    expect(result.shouldComment).toBe(false);
    expect(result.wouldComment).toBe(true);
  });

  it('flags PR in enforce mode with label/comment side effects', () => {
    const result = evaluateDecision({ ...DEFAULT_CONFIG, dryRun: false }, makeReport(10), 'normal body');
    expect(result.decision).toBe('flagged');
    expect(result.shouldComment).toBe(true);
    expect(result.shouldLabel).toBe(true);
  });

  it('short-circuits with override token', () => {
    const result = evaluateDecision({ ...DEFAULT_CONFIG, dryRun: false }, makeReport(10), 'please review [human-authored]');
    expect(result.decision).toBe('overridden');
    expect(result.shouldComment).toBe(false);
    expect(result.wouldComment).toBe(true);
  });

  it('requests human review only when enabled and not auto-closing', () => {
    const result = evaluateDecision(
      { ...DEFAULT_CONFIG, dryRun: false, requestHumanReview: true, closeOnTrigger: false },
      makeReport(10),
      'normal body'
    );
    expect(result.shouldRequestHumanReview).toBe(true);
  });
});
