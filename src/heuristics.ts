import { HEURISTIC_WEIGHTS } from './constants';
import type {
  HeuristicId,
  HeuristicResult,
  HeuristicStatus,
  PrContext,
  ScoreReport
} from './types';

interface HeuristicEvaluation {
  status: HeuristicStatus;
  reason: string;
  evidence: Record<string, string | number | boolean | null>;
}

function makeResult(id: HeuristicId, name: string, evaluation: HeuristicEvaluation): HeuristicResult {
  const maxPoints = HEURISTIC_WEIGHTS[id];
  return {
    id,
    name,
    maxPoints,
    points: evaluation.status === 'triggered' ? maxPoints : 0,
    status: evaluation.status,
    reason: evaluation.reason,
    evidence: evaluation.evidence
  };
}

const GENERIC_COMMIT_PATTERNS: RegExp[] = [
  /^add\s+.+\s+to\s+.+/i,
  /^implement\s+.+(feature|functionality)/i,
  /^fix\s+(issue|bug|problem)\s+(with|in)\s+.+/i,
  /^(add|implement|fix|update|refactor)\b/i,
  /^this\s+commit\s+/i
];

const GENERIC_DESCRIPTION_PATTERNS: RegExp[] = [
  /^this\s+pr\s+/i,
  /^summary[:\s]/i,
  /^changes[:\s]/i,
  /^implements?\s+/i,
  /^fixes?\s+/i,
  /^updates?\s+/i,
  /^improves?\s+/i,
  /^enhances?\s+/i
];

const CODE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.m',
  '.mm',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.scala',
  '.sh',
  '.sql',
  '.swift',
  '.ts',
  '.tsx'
]);

function fileExtension(path: string): string {
  const fileName = path.split('/').pop() ?? path;
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) {
    return '';
  }
  return fileName.slice(dot).toLowerCase();
}

export function isTestFile(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.includes('/test/') ||
    lower.includes('/tests/') ||
    lower.includes('__tests__') ||
    lower.includes('.test.') ||
    lower.includes('.spec.') ||
    lower.endsWith('_test.go') ||
    lower.endsWith('test.py')
  );
}

export function isCodeFile(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.rst')) {
    return false;
  }
  return CODE_EXTENSIONS.has(fileExtension(path));
}

function isGenericCommitSubject(subject: string): boolean {
  const normalized = subject.trim();
  if (normalized.length === 0) {
    return true;
  }

  return GENERIC_COMMIT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isGenericDescription(body: string): boolean {
  const trimmed = body.trim();

  if (trimmed.length === 0) {
    return true;
  }

  const firstLine = trimmed.split('\n').find((line) => line.trim().length > 0) ?? trimmed;
  const normalized = firstLine.trim();

  if (GENERIC_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const wordCount = trimmed.split(/\s+/).filter((word) => word.length > 0).length;
  if (wordCount < 15) {
    const genericWords = ['update', 'fix', 'implement', 'improve', 'change', 'feature'];
    const lower = trimmed.toLowerCase();
    const matches = genericWords.filter((word) => lower.includes(word)).length;
    return matches >= 2;
  }

  return false;
}

function evaluateFirstPr(context: PrContext): HeuristicEvaluation {
  const prCount = context.participation.prCount;
  if (prCount === null) {
    return {
      status: 'unknown',
      reason: 'Unable to determine prior pull request history.',
      evidence: {
        pr_count: null
      }
    };
  }

  const triggered = prCount <= 1;
  return {
    status: triggered ? 'triggered' : 'not_triggered',
    reason: triggered
      ? 'Contributor appears to be opening their first PR in this repository.'
      : 'Contributor has previous PR history in this repository.',
    evidence: {
      pr_count: prCount
    }
  };
}

function evaluateWideSingleCommit(context: PrContext): HeuristicEvaluation {
  const commitCount = context.commits.length;
  const fileCount = context.files.length;

  const triggered = commitCount === 1 && fileCount > 5;
  return {
    status: triggered ? 'triggered' : 'not_triggered',
    reason: triggered
      ? 'Single-commit PR touches more than 5 files.'
      : 'PR does not match the wide single-commit pattern.',
    evidence: {
      commit_count: commitCount,
      file_count: fileCount
    }
  };
}

function evaluateCodeWithoutTests(context: PrContext): HeuristicEvaluation {
  const codeFiles = context.files.filter((file) => isCodeFile(file.filename));
  const testFiles = context.files.filter((file) => isTestFile(file.filename));

  if (codeFiles.length === 0) {
    return {
      status: 'not_triggered',
      reason: 'No code files changed.',
      evidence: {
        code_file_count: 0,
        test_file_count: testFiles.length
      }
    };
  }

  const triggered = testFiles.length === 0;

  return {
    status: triggered ? 'triggered' : 'not_triggered',
    reason: triggered
      ? 'Code files changed but no test files were modified.'
      : 'Code changes include test updates.',
    evidence: {
      code_file_count: codeFiles.length,
      test_file_count: testFiles.length
    }
  };
}

function evaluateCommitMessage(context: PrContext): HeuristicEvaluation {
  const subjects = context.commits.map((commit) => commit.message.split('\n')[0]?.trim() ?? '');

  if (subjects.length === 0) {
    return {
      status: 'unknown',
      reason: 'Unable to inspect commit messages.',
      evidence: {
        commit_count: 0,
        generic_commit_ratio: null
      }
    };
  }

  const genericCount = subjects.filter((subject) => isGenericCommitSubject(subject)).length;
  const ratio = genericCount / subjects.length;
  const triggered = (subjects.length === 1 && genericCount === 1) || (subjects.length > 1 && ratio >= 0.8);

  return {
    status: triggered ? 'triggered' : 'not_triggered',
    reason: triggered
      ? 'Commit subject(s) match generic AI-style phrasing patterns.'
      : 'Commit subject patterns look specific enough.',
    evidence: {
      commit_count: subjects.length,
      generic_commit_count: genericCount,
      generic_commit_ratio: Number(ratio.toFixed(2))
    }
  };
}

function evaluateFastForkToPr(context: PrContext): HeuristicEvaluation {
  const headRepoCreatedAt = context.pullRequest.headRepoCreatedAt;

  if (!context.pullRequest.headRepoFork || !headRepoCreatedAt) {
    return {
      status: 'unknown',
      reason: 'Head repository is not a fork or fork creation time is unavailable.',
      evidence: {
        head_repo_fork: context.pullRequest.headRepoFork,
        fork_to_pr_seconds: null
      }
    };
  }

  const prCreatedAt = new Date(context.pullRequest.createdAt).getTime();
  const forkCreatedAt = new Date(headRepoCreatedAt).getTime();

  if (Number.isNaN(prCreatedAt) || Number.isNaN(forkCreatedAt)) {
    return {
      status: 'unknown',
      reason: 'Invalid timestamp(s) for fork-to-PR timing.',
      evidence: {
        head_repo_fork: context.pullRequest.headRepoFork,
        fork_to_pr_seconds: null
      }
    };
  }

  const seconds = Math.round((prCreatedAt - forkCreatedAt) / 1000);

  if (seconds < 0) {
    return {
      status: 'unknown',
      reason: 'Fork creation time is later than PR creation time.',
      evidence: {
        head_repo_fork: context.pullRequest.headRepoFork,
        fork_to_pr_seconds: seconds
      }
    };
  }

  const triggered = seconds < 60;

  return {
    status: triggered ? 'triggered' : 'not_triggered',
    reason: triggered
      ? 'Fork-to-PR interval is under 60 seconds.'
      : 'Fork-to-PR interval exceeds 60 seconds.',
    evidence: {
      head_repo_fork: context.pullRequest.headRepoFork,
      fork_to_pr_seconds: seconds
    }
  };
}

function evaluateDescription(context: PrContext): HeuristicEvaluation {
  const body = context.pullRequest.body ?? '';
  const triggered = isGenericDescription(body);

  return {
    status: triggered ? 'triggered' : 'not_triggered',
    reason: triggered
      ? 'PR description is empty or appears generic/template-like.'
      : 'PR description appears specific.',
    evidence: {
      description_length: body.trim().length
    }
  };
}

function evaluateParticipation(context: PrContext): HeuristicEvaluation {
  const { issueCount, discussionCount } = context.participation;

  if (issueCount !== null && issueCount > 0) {
    return {
      status: 'not_triggered',
      reason: 'Contributor has prior issue participation.',
      evidence: {
        issue_count: issueCount,
        discussion_count: discussionCount
      }
    };
  }

  if (issueCount === null && discussionCount === null) {
    return {
      status: 'unknown',
      reason: 'Unable to determine prior issue/discussion participation.',
      evidence: {
        issue_count: null,
        discussion_count: null
      }
    };
  }

  if (issueCount === 0 && discussionCount === null) {
    return {
      status: 'unknown',
      reason: 'Issue history is empty but discussion history is unavailable.',
      evidence: {
        issue_count: issueCount,
        discussion_count: discussionCount
      }
    };
  }

  const triggered = issueCount === 0 && discussionCount === 0;

  return {
    status: triggered ? 'triggered' : 'not_triggered',
    reason: triggered
      ? 'No prior issue/discussion participation detected.'
      : 'Contributor has prior discussion participation.',
    evidence: {
      issue_count: issueCount,
      discussion_count: discussionCount
    }
  };
}

export function scorePullRequest(context: PrContext, threshold: number): ScoreReport {
  const heuristicResults: HeuristicResult[] = [
    makeResult('first_pr', 'First PR from contributor', evaluateFirstPr(context)),
    makeResult(
      'wide_single_commit',
      'PR touches >5 files with a single commit',
      evaluateWideSingleCommit(context)
    ),
    makeResult('code_without_tests', 'Code changes without tests', evaluateCodeWithoutTests(context)),
    makeResult('generic_commit_message', 'Generic commit message pattern', evaluateCommitMessage(context)),
    makeResult('fast_fork_to_pr', 'Fork-to-PR time under 60 seconds', evaluateFastForkToPr(context)),
    makeResult('generic_pr_description', 'Generic or empty PR description', evaluateDescription(context)),
    makeResult('no_prior_participation', 'No prior issues/discussions participation', evaluateParticipation(context))
  ];

  const triggeredHeuristics = heuristicResults
    .filter((result) => result.status === 'triggered')
    .map((result) => result.id);

  const total = heuristicResults.reduce((sum, result) => sum + result.points, 0);

  return {
    total,
    threshold,
    heuristics: heuristicResults,
    triggeredHeuristics,
    warnings: [...context.warnings]
  };
}
