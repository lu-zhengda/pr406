import { describe, expect, it } from 'vitest';

import { scorePullRequest } from '../../src/heuristics';
import type { PrContext } from '../../src/types';

function makeBaseContext(): PrContext {
  return {
    pullRequest: {
      number: 1,
      authorLogin: 'alice',
      body: 'This PR improves parser edge cases with regression coverage.',
      createdAt: '2026-03-07T12:00:30Z',
      headRepoCreatedAt: '2026-03-07T12:00:00Z',
      headRepoFork: true,
      state: 'open',
      labels: []
    },
    files: [
      {
        filename: 'src/index.ts',
        status: 'modified',
        additions: 10,
        deletions: 2,
        changes: 12
      },
      {
        filename: 'tests/index.test.ts',
        status: 'modified',
        additions: 6,
        deletions: 0,
        changes: 6
      }
    ],
    commits: [
      {
        sha: 'abc',
        message: 'Improve parser edge-case handling\n\nDetailed body'
      }
    ],
    participation: {
      prCount: 1,
      issueCount: 0,
      discussionCount: 0
    },
    warnings: []
  };
}

describe('scorePullRequest', () => {
  it('scores a high-risk bot-like PR above threshold', () => {
    const context = makeBaseContext();
    context.pullRequest.body = '';
    context.files = [
      { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
      { filename: 'src/b.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
      { filename: 'src/c.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
      { filename: 'src/d.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
      { filename: 'src/e.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
      { filename: 'src/f.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 }
    ];
    context.commits = [{ sha: 'abc', message: 'Implement login feature' }];
    context.participation = { prCount: 1, issueCount: 0, discussionCount: 0 };

    const report = scorePullRequest(context, 7);
    expect(report.total).toBeGreaterThanOrEqual(10);
    expect(report.triggeredHeuristics).toContain('first_pr');
    expect(report.triggeredHeuristics).toContain('fast_fork_to_pr');
    expect(report.triggeredHeuristics).toContain('code_without_tests');
  });

  it('does not trigger code-without-tests when test files are present', () => {
    const report = scorePullRequest(makeBaseContext(), 7);
    const heuristic = report.heuristics.find((item) => item.id === 'code_without_tests');
    expect(heuristic?.status).toBe('not_triggered');
  });

  it('treats fast fork heuristic as unknown when head repo is not a fork', () => {
    const context = makeBaseContext();
    context.pullRequest.headRepoFork = false;
    context.pullRequest.headRepoCreatedAt = null;

    const report = scorePullRequest(context, 7);
    const heuristic = report.heuristics.find((item) => item.id === 'fast_fork_to_pr');
    expect(heuristic?.status).toBe('unknown');
  });

  it('treats no-participation heuristic as unknown when discussion history is unavailable', () => {
    const context = makeBaseContext();
    context.participation = { prCount: 2, issueCount: 0, discussionCount: null };

    const report = scorePullRequest(context, 7);
    const heuristic = report.heuristics.find((item) => item.id === 'no_prior_participation');
    expect(heuristic?.status).toBe('unknown');
  });

  it('does not trigger generic-commit heuristic for specific messages', () => {
    const context = makeBaseContext();
    context.commits = [
      { sha: '1', message: 'Normalize parser AST traversal order' },
      { sha: '2', message: 'Add regression for nested expression parsing' }
    ];

    const report = scorePullRequest(context, 7);
    const heuristic = report.heuristics.find((item) => item.id === 'generic_commit_message');
    expect(heuristic?.status).toBe('not_triggered');
  });
});
