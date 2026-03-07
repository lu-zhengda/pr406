import { loadConfigFromRepo } from './config';
import {
  buildPrContext,
  ensureComment,
  ensureLabel,
  maybeClosePullRequest,
  maybeRequestHumanReview
} from './github-api';
import { scorePullRequest } from './heuristics';
import { evaluateDecision } from './policy';
import { renderResponseTemplate } from './template';
import type { ActionReport, GitHubApi, PullRequestPayload } from './types';

export interface SideEffectSummary {
  labelApplied: boolean;
  commentApplied: boolean;
  pullRequestClosed: boolean;
  humanReviewRequested: boolean;
  warnings: string[];
}

export interface RunPr406Result {
  actionReport: ActionReport;
  sideEffects: SideEffectSummary;
}

interface RunPr406Args {
  github: GitHubApi;
  owner: string;
  repo: string;
  configPath: string;
  pullRequest: PullRequestPayload;
}

export async function runPr406(args: RunPr406Args): Promise<RunPr406Result> {
  const { github, owner, repo, configPath, pullRequest } = args;

  const configLoad = await loadConfigFromRepo({
    github,
    owner,
    repo,
    configPath,
    ref: pullRequest.base.ref
  });

  const contextResult = await buildPrContext({
    github,
    owner,
    repo,
    pullRequest
  });

  const scoreReport = scorePullRequest(contextResult.context, configLoad.config.threshold);
  scoreReport.warnings.push(...configLoad.warnings);

  const decision = evaluateDecision(configLoad.config, scoreReport, pullRequest.body ?? '');
  const actionReport: ActionReport = {
    decision,
    scoreReport,
    config: configLoad.config
  };

  const sideEffects: SideEffectSummary = {
    labelApplied: false,
    commentApplied: false,
    pullRequestClosed: false,
    humanReviewRequested: false,
    warnings: []
  };

  if (!decision.shouldLabel && !decision.shouldComment && !decision.shouldClose && !decision.shouldRequestHumanReview) {
    return {
      actionReport,
      sideEffects
    };
  }

  if (decision.shouldLabel) {
    try {
      sideEffects.labelApplied = await ensureLabel(
        github,
        owner,
        repo,
        pullRequest.number,
        contextResult.context.pullRequest.labels,
        configLoad.config.label
      );
    } catch {
      sideEffects.warnings.push(`Failed to add label ${configLoad.config.label}.`);
    }
  }

  if (decision.shouldComment) {
    const commentBody = renderResponseTemplate(configLoad.config.responseTemplate, scoreReport, decision);
    try {
      sideEffects.commentApplied = await ensureComment(github, owner, repo, pullRequest.number, commentBody);
    } catch {
      sideEffects.warnings.push('Failed to create 406 response comment.');
    }
  }

  if (decision.shouldClose) {
    try {
      sideEffects.pullRequestClosed = await maybeClosePullRequest(
        github,
        owner,
        repo,
        pullRequest.number,
        pullRequest.state
      );
    } catch {
      sideEffects.warnings.push('Failed to close pull request automatically.');
    }
  }

  if (decision.shouldRequestHumanReview) {
    const reviewResult = await maybeRequestHumanReview(
      github,
      owner,
      repo,
      pullRequest.number,
      pullRequest.user.login
    );
    sideEffects.humanReviewRequested = reviewResult.requested;
    if (reviewResult.warning) {
      sideEffects.warnings.push(reviewResult.warning);
    }
  }

  return {
    actionReport,
    sideEffects
  };
}
