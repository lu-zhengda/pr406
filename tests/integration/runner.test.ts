import { describe, expect, it, vi } from 'vitest';

import { COMMENT_MARKER } from '../../src/constants';
import { runPr406 } from '../../src/runner';
import type { GitHubApi, PullRequestPayload } from '../../src/types';

function encodeYaml(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

function makePullRequest(): PullRequestPayload {
  return {
    number: 42,
    body: '',
    created_at: '2026-03-07T12:00:45Z',
    state: 'open',
    user: {
      login: 'contributor-user'
    },
    labels: [],
    head: {
      repo: {
        created_at: '2026-03-07T12:00:00Z',
        fork: true
      }
    },
    base: {
      ref: 'main'
    }
  };
}

function createMockGithub(configYaml: string): GitHubApi {
  const searchMock = vi.fn(async ({ q }: { q: string }) => {
    if (q.includes('is:pr')) {
      return { data: { total_count: 1 } };
    }
    if (q.includes('is:issue')) {
      return { data: { total_count: 0 } };
    }
    return { data: { total_count: 0 } };
  });

  return {
    rest: {
      repos: {
        getContent: vi.fn(async () => ({
          data: {
            type: 'file',
            content: encodeYaml(configYaml)
          }
        }))
      },
      pulls: {
        list: vi.fn(async () => ({
          data: [
            {
              user: {
                login: 'contributor-user'
              }
            }
          ]
        })),
        listFiles: vi.fn(async () => ({
          data: [
            { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
            { filename: 'src/b.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
            { filename: 'src/c.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
            { filename: 'src/d.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
            { filename: 'src/e.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
            { filename: 'src/f.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 }
          ]
        })),
        listCommits: vi.fn(async () => ({
          data: [
            {
              sha: 'abc',
              commit: {
                message: 'Implement parser feature'
              }
            }
          ]
        })),
        update: vi.fn(async () => ({})),
        listRequestedReviewers: vi.fn(async () => ({
          data: {
            users: []
          }
        })),
        requestReviewers: vi.fn(async () => ({}))
      },
      issues: {
        listComments: vi.fn(async () => ({ data: [] })),
        createComment: vi.fn(async () => ({})),
        addLabels: vi.fn(async () => ({}))
      },
      search: {
        issuesAndPullRequests: searchMock
      }
    },
    graphql: vi.fn(async () => ({
      search: {
        discussionCount: 0
      }
    })) as unknown as GitHubApi['graphql']
  };
}

describe('runPr406 integration', () => {
  it('runs in dry-run mode without side effects', async () => {
    const github = createMockGithub([
      'threshold: 7',
      'dry_run: true',
      'label: ai-generated',
      'close_on_trigger: false',
      'request_human_review: false',
      'human_override_token: "[human-authored]"',
      'response_template: "406 {{score}} {{threshold}}"'
    ].join('\n'));

    const result = await runPr406({
      github,
      owner: 'owner-user',
      repo: 'sandbox',
      configPath: '.github/pr406.yml',
      pullRequest: makePullRequest()
    });

    expect(result.actionReport.decision.decision).toBe('flagged');
    expect(result.sideEffects.labelApplied).toBe(false);
    expect(result.sideEffects.commentApplied).toBe(false);
    expect((github.rest.issues.addLabels as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('enforces label and comment in enforce mode', async () => {
    const github = createMockGithub([
      'threshold: 7',
      'dry_run: false',
      'label: ai-generated',
      'close_on_trigger: false',
      'request_human_review: false',
      'human_override_token: "[human-authored]"',
      `response_template: "${COMMENT_MARKER}\\n406 {{score}}"`
    ].join('\n'));

    const result = await runPr406({
      github,
      owner: 'owner-user',
      repo: 'sandbox',
      configPath: '.github/pr406.yml',
      pullRequest: makePullRequest()
    });

    expect(result.actionReport.decision.decision).toBe('flagged');
    expect(result.sideEffects.labelApplied).toBe(true);
    expect(result.sideEffects.commentApplied).toBe(true);
    expect((github.rest.issues.addLabels as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((github.rest.issues.createComment as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('gracefully degrades when participation lookups fail', async () => {
    const github = createMockGithub('threshold: 7\ndry_run: true');

    (github.rest.search.issuesAndPullRequests as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('search down')
    );
    (github.rest.search.issuesAndPullRequests as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('search down')
    );
    (github.rest.pulls.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('pull list down'));
    (github.graphql as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('graphql down'));

    const result = await runPr406({
      github,
      owner: 'owner-user',
      repo: 'sandbox',
      configPath: '.github/pr406.yml',
      pullRequest: makePullRequest()
    });

    expect(result.actionReport.scoreReport.warnings.length).toBeGreaterThan(0);
    expect(result.actionReport.scoreReport.heuristics.find((h) => h.id === 'first_pr')?.status).toBe('unknown');
    expect(result.actionReport.scoreReport.heuristics.find((h) => h.id === 'no_prior_participation')?.status).toBe(
      'unknown'
    );
  });

  it('respects override token by suppressing side effects', async () => {
    const github = createMockGithub('threshold: 7\ndry_run: false');
    const pr = makePullRequest();
    pr.body = 'Maintainer note [human-authored]';

    const result = await runPr406({
      github,
      owner: 'owner-user',
      repo: 'sandbox',
      configPath: '.github/pr406.yml',
      pullRequest: pr
    });

    expect(result.actionReport.decision.decision).toBe('overridden');
    expect(result.sideEffects.labelApplied).toBe(false);
    expect((github.rest.issues.addLabels as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});
