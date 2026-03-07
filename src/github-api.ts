import type {
  BuildPrContextResult,
  CommitData,
  FileChange,
  GitHubApi,
  IssueComment,
  ParticipationSnapshot,
  PullRequestPayload,
  PullRequestSnapshot
} from './types';
import { includesCommentMarker } from './template';

interface BuildPrContextArgs {
  github: GitHubApi;
  owner: string;
  repo: string;
  pullRequest: PullRequestPayload;
}

interface RepoCoordinates {
  owner: string;
  repo: string;
  pullNumber: number;
}

async function listAllFiles(github: GitHubApi, coordinates: RepoCoordinates): Promise<FileChange[]> {
  const files: FileChange[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await github.rest.pulls.listFiles({
      owner: coordinates.owner,
      repo: coordinates.repo,
      pull_number: coordinates.pullNumber,
      per_page: perPage,
      page
    });

    files.push(...response.data);

    if (response.data.length < perPage) {
      break;
    }

    page += 1;
  }

  return files;
}

async function listAllCommits(github: GitHubApi, coordinates: RepoCoordinates): Promise<CommitData[]> {
  const commits: CommitData[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await github.rest.pulls.listCommits({
      owner: coordinates.owner,
      repo: coordinates.repo,
      pull_number: coordinates.pullNumber,
      per_page: perPage,
      page
    });

    commits.push(
      ...response.data.map((commit) => ({
        sha: commit.sha,
        message: commit.commit.message
      }))
    );

    if (response.data.length < perPage) {
      break;
    }

    page += 1;
  }

  return commits;
}

async function countSearchResults(github: GitHubApi, query: string): Promise<number> {
  const response = await github.rest.search.issuesAndPullRequests({
    q: query,
    per_page: 1,
    page: 1
  });

  return response.data.total_count;
}

async function countPullRequestsByAuthorFromList(
  github: GitHubApi,
  owner: string,
  repo: string,
  author: string
): Promise<number> {
  let page = 1;
  const perPage = 100;
  let count = 0;

  while (true) {
    const response = await github.rest.pulls.list({
      owner,
      repo,
      state: 'all',
      per_page: perPage,
      page
    });

    count += response.data.filter((pull) => pull.user.login.toLowerCase() === author.toLowerCase()).length;

    if (response.data.length < perPage) {
      break;
    }

    page += 1;
  }

  return count;
}

async function countPullRequestsByAuthor(
  github: GitHubApi,
  owner: string,
  repo: string,
  author: string
): Promise<{ count: number | null; warning?: string }> {
  let searchCount: number | null = null;

  try {
    searchCount = await countSearchResults(github, `repo:${owner}/${repo} is:pr author:${author}`);
  } catch {
    // Fall through to list-based fallback.
  }

  if (searchCount !== null && searchCount > 1) {
    return {
      count: searchCount
    };
  }

  try {
    const fallbackCount = await countPullRequestsByAuthorFromList(github, owner, repo, author);
    return {
      count: fallbackCount,
      warning:
        searchCount === null
          ? 'PR history search failed; used pull list fallback for first-PR heuristic.'
          : 'PR history search count was borderline; used pull list fallback for first-PR heuristic.'
    };
  } catch {
    if (searchCount !== null) {
      return {
        count: searchCount,
        warning: 'Pull list fallback failed; used search count for first-PR heuristic.'
      };
    }

    return {
      count: null,
      warning: 'Unable to query PR history for contributor.'
    };
  }
}

interface DiscussionSearchResponse {
  search?: {
    discussionCount?: number;
  };
}

async function fetchParticipation(
  github: GitHubApi,
  owner: string,
  repo: string,
  author: string
): Promise<{ snapshot: ParticipationSnapshot; warnings: string[] }> {
  const warnings: string[] = [];

  let prCount: number | null = null;
  let issueCount: number | null = null;
  let discussionCount: number | null = null;

  const prCountResult = await countPullRequestsByAuthor(github, owner, repo, author);
  prCount = prCountResult.count;
  if (prCountResult.warning) {
    warnings.push(prCountResult.warning);
  }

  try {
    issueCount = await countSearchResults(github, `repo:${owner}/${repo} is:issue author:${author}`);
  } catch {
    warnings.push('Unable to query issue participation history for contributor.');
  }

  try {
    const response = await github.graphql<DiscussionSearchResponse>(
      `query($searchQuery: String!) {
         search(type: DISCUSSION, query: $searchQuery, first: 1) {
           discussionCount
         }
       }`,
      {
        searchQuery: `repo:${owner}/${repo} author:${author}`
      }
    );

    if (typeof response.search?.discussionCount === 'number') {
      discussionCount = response.search.discussionCount;
    } else {
      warnings.push('Discussion search API returned an unexpected shape.');
    }
  } catch {
    warnings.push('Unable to query discussion participation history for contributor.');
  }

  return {
    snapshot: {
      prCount,
      issueCount,
      discussionCount
    },
    warnings
  };
}

function toPullRequestSnapshot(pullRequest: PullRequestPayload): PullRequestSnapshot {
  return {
    number: pullRequest.number,
    authorLogin: pullRequest.user.login,
    body: pullRequest.body ?? '',
    createdAt: pullRequest.created_at,
    headRepoCreatedAt: pullRequest.head.repo?.created_at ?? null,
    headRepoFork: pullRequest.head.repo?.fork ?? false,
    state: pullRequest.state,
    labels: pullRequest.labels
      .map((label) => label.name)
      .filter((name): name is string => typeof name === 'string')
  };
}

export async function buildPrContext(args: BuildPrContextArgs): Promise<BuildPrContextResult> {
  const { github, owner, repo, pullRequest } = args;

  const coordinates: RepoCoordinates = {
    owner,
    repo,
    pullNumber: pullRequest.number
  };

  const warnings: string[] = [];

  const filesPromise = listAllFiles(github, coordinates).catch(() => {
    warnings.push('Unable to list changed files for PR; treating as empty change set.');
    return [] as FileChange[];
  });

  const commitsPromise = listAllCommits(github, coordinates).catch(() => {
    warnings.push('Unable to list commits for PR; commit heuristics may be unknown.');
    return [] as CommitData[];
  });

  const participationPromise = fetchParticipation(github, owner, repo, pullRequest.user.login).catch(() => {
    warnings.push('Unable to fetch contributor participation history.');
    return {
      snapshot: {
        prCount: null,
        issueCount: null,
        discussionCount: null
      },
      warnings: []
    };
  });

  const [files, commits, participation] = await Promise.all([
    filesPromise,
    commitsPromise,
    participationPromise
  ]);

  warnings.push(...participation.warnings);

  return {
    context: {
      pullRequest: toPullRequestSnapshot(pullRequest),
      files,
      commits,
      participation: participation.snapshot,
      warnings
    },
    warnings
  };
}

export async function listAllIssueComments(
  github: GitHubApi,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<IssueComment[]> {
  const comments: IssueComment[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await github.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: perPage,
      page
    });

    comments.push(...response.data);

    if (response.data.length < perPage) {
      break;
    }

    page += 1;
  }

  return comments;
}

export async function ensureLabel(
  github: GitHubApi,
  owner: string,
  repo: string,
  issueNumber: number,
  existingLabels: string[],
  label: string
): Promise<boolean> {
  if (existingLabels.includes(label)) {
    return false;
  }

  await github.rest.issues.addLabels({
    owner,
    repo,
    issue_number: issueNumber,
    labels: [label]
  });

  return true;
}

export async function ensureComment(
  github: GitHubApi,
  owner: string,
  repo: string,
  issueNumber: number,
  commentBody: string
): Promise<boolean> {
  const comments = await listAllIssueComments(github, owner, repo, issueNumber);
  const alreadyExists = comments.some((comment) => includesCommentMarker(comment.body));

  if (alreadyExists) {
    return false;
  }

  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: commentBody
  });

  return true;
}

export async function maybeClosePullRequest(
  github: GitHubApi,
  owner: string,
  repo: string,
  pullNumber: number,
  currentState: string
): Promise<boolean> {
  if (currentState === 'closed') {
    return false;
  }

  await github.rest.pulls.update({
    owner,
    repo,
    pull_number: pullNumber,
    state: 'closed'
  });

  return true;
}

export async function maybeRequestHumanReview(
  github: GitHubApi,
  owner: string,
  repo: string,
  pullNumber: number,
  prAuthor: string
): Promise<{ requested: boolean; warning?: string }> {
  if (owner === prAuthor) {
    return {
      requested: false,
      warning: 'Cannot auto-request human review because PR author is repository owner.'
    };
  }

  try {
    const existing = await github.rest.pulls.listRequestedReviewers({
      owner,
      repo,
      pull_number: pullNumber
    });

    const alreadyRequested = existing.data.users.some((user) => user.login.toLowerCase() === owner.toLowerCase());

    if (alreadyRequested) {
      return {
        requested: false
      };
    }

    await github.rest.pulls.requestReviewers({
      owner,
      repo,
      pull_number: pullNumber,
      reviewers: [owner]
    });

    return {
      requested: true
    };
  } catch {
    return {
      requested: false,
      warning:
        'Failed to request human review automatically. Configure manual review flow or grant reviewer permissions.'
    };
  }
}
