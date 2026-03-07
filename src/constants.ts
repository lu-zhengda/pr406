import type { Pr406Config } from './types';

export const COMMENT_MARKER = '<!-- pr406:comment-v1 -->';

export const DEFAULT_RESPONSE_TEMPLATE = [
  COMMENT_MARKER,
  '',
  '406 Not Acceptable: this pull request appears to match our automated low-confidence contribution patterns.',
  '',
  '- Score: `{{score}} / threshold {{threshold}}`',
  '- Triggered heuristics: {{triggered_heuristics}}',
  '- Decision: `{{decision}}`',
  '',
  'If this PR is human-authored, add `{{override_token}}` to the PR description and request maintainer review.'
].join('\n');

export const DEFAULT_CONFIG: Pr406Config = {
  threshold: 7,
  dryRun: true,
  label: 'ai-generated',
  closeOnTrigger: false,
  requestHumanReview: false,
  humanOverrideToken: '[human-authored]',
  responseTemplate: DEFAULT_RESPONSE_TEMPLATE
};

export const HEURISTIC_WEIGHTS = {
  first_pr: 1,
  wide_single_commit: 2,
  code_without_tests: 2,
  generic_commit_message: 1,
  fast_fork_to_pr: 3,
  generic_pr_description: 1,
  no_prior_participation: 1
} as const;
