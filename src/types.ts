export type HeuristicId =
  | 'first_pr'
  | 'wide_single_commit'
  | 'code_without_tests'
  | 'generic_commit_message'
  | 'fast_fork_to_pr'
  | 'generic_pr_description'
  | 'no_prior_participation';

export type HeuristicStatus = 'triggered' | 'not_triggered' | 'unknown';

export interface HeuristicResult {
  id: HeuristicId;
  name: string;
  points: number;
  maxPoints: number;
  status: HeuristicStatus;
  reason: string;
  evidence: Record<string, string | number | boolean | null>;
}

export interface ScoreReport {
  total: number;
  threshold: number;
  heuristics: HeuristicResult[];
  triggeredHeuristics: HeuristicId[];
  warnings: string[];
}

export type FinalDecision = 'allow' | 'flagged' | 'overridden';

export interface DecisionResult {
  decision: FinalDecision;
  overrideApplied: boolean;
  overrideToken: string;
  shouldLabel: boolean;
  shouldComment: boolean;
  shouldClose: boolean;
  shouldRequestHumanReview: boolean;
  wouldLabel: boolean;
  wouldComment: boolean;
  wouldClose: boolean;
  wouldRequestHumanReview: boolean;
  reason: string;
}

export interface Pr406Config {
  threshold: number;
  dryRun: boolean;
  label: string;
  closeOnTrigger: boolean;
  requestHumanReview: boolean;
  humanOverrideToken: string;
  responseTemplate: string;
}

export interface FileChange {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export interface CommitData {
  sha: string;
  message: string;
}

export interface ParticipationSnapshot {
  prCount: number | null;
  issueCount: number | null;
  discussionCount: number | null;
}

export interface PullRequestSnapshot {
  number: number;
  authorLogin: string;
  body: string;
  createdAt: string;
  headRepoCreatedAt: string | null;
  headRepoFork: boolean;
  state: string;
  labels: string[];
}

export interface PrContext {
  pullRequest: PullRequestSnapshot;
  files: FileChange[];
  commits: CommitData[];
  participation: ParticipationSnapshot;
  warnings: string[];
}

export interface LoadConfigResult {
  config: Pr406Config;
  warnings: string[];
}

export interface BuildPrContextResult {
  context: PrContext;
  warnings: string[];
}

export interface ActionReport {
  decision: DecisionResult;
  scoreReport: ScoreReport;
  config: Pr406Config;
}

export interface PullRequestPayload {
  number: number;
  body: string | null;
  created_at: string;
  state: string;
  user: {
    login: string;
  };
  labels: Array<{
    name?: string;
  }>;
  head: {
    repo: {
      created_at: string | null;
      fork: boolean;
    } | null;
  };
  base: {
    ref: string;
  };
}

export interface IssueComment {
  id: number;
  body: string | null;
}

export interface GitHubApi {
  rest: {
    repos: {
      getContent(params: {
        owner: string;
        repo: string;
        path: string;
        ref?: string;
      }): Promise<{
        data:
          | {
              type: 'file';
              content: string;
            }
          | {
              type: string;
              content?: string;
            }
          | Array<unknown>;
      }>;
    };
    pulls: {
      listFiles(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: Array<{
          filename: string;
          status: string;
          additions: number;
          deletions: number;
          changes: number;
        }>;
      }>;
      listCommits(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: Array<{
          sha: string;
          commit: {
            message: string;
          };
        }>;
      }>;
      list(params: {
        owner: string;
        repo: string;
        state: 'open' | 'closed' | 'all';
        per_page?: number;
        page?: number;
      }): Promise<{
        data: Array<{
          user: {
            login: string;
          };
        }>;
      }>;
      update(params: {
        owner: string;
        repo: string;
        pull_number: number;
        state: 'open' | 'closed';
      }): Promise<unknown>;
      listRequestedReviewers(params: {
        owner: string;
        repo: string;
        pull_number: number;
      }): Promise<{
        data: {
          users: Array<{
            login: string;
          }>;
        };
      }>;
      requestReviewers(params: {
        owner: string;
        repo: string;
        pull_number: number;
        reviewers: string[];
      }): Promise<unknown>;
    };
    issues: {
      listComments(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: IssueComment[];
      }>;
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<unknown>;
      addLabels(params: {
        owner: string;
        repo: string;
        issue_number: number;
        labels: string[];
      }): Promise<unknown>;
    };
    search: {
      issuesAndPullRequests(params: {
        q: string;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: {
          total_count: number;
        };
      }>;
    };
  };
  graphql<T>(query: string, parameters: Record<string, unknown>): Promise<T>;
}
