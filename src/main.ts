import * as core from '@actions/core';
import * as github from '@actions/github';

import { runPr406 } from './runner';
import type { GitHubApi, PullRequestPayload } from './types';

interface PullRequestEventPayload {
  action?: string;
  pull_request?: PullRequestPayload;
}

function formatList(values: string[]): string {
  if (values.length === 0) {
    return 'none';
  }
  return values.join(', ');
}

async function run(): Promise<void> {
  try {
    const tokenInput = core.getInput('github_token');
    const token = tokenInput.length > 0 ? tokenInput : process.env.GITHUB_TOKEN;

    if (!token) {
      core.setFailed('Missing GitHub token. Provide input `github_token` or env `GITHUB_TOKEN`.');
      return;
    }

    const configPath = core.getInput('config_path') || '.github/pr406.yml';

    const payload = github.context.payload as PullRequestEventPayload;
    const pullRequest = payload.pull_request;

    if (!pullRequest) {
      core.setFailed('This action must run on pull_request or pull_request_target events.');
      return;
    }

    const octokit = github.getOctokit(token) as unknown as GitHubApi;

    const result = await runPr406({
      github: octokit,
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      configPath,
      pullRequest
    });

    const reportPayload = {
      decision: result.actionReport.decision.decision,
      score: result.actionReport.scoreReport.total,
      threshold: result.actionReport.scoreReport.threshold,
      triggered_heuristics: result.actionReport.scoreReport.triggeredHeuristics,
      warnings: [...result.actionReport.scoreReport.warnings, ...result.sideEffects.warnings],
      side_effects: {
        label_applied: result.sideEffects.labelApplied,
        comment_applied: result.sideEffects.commentApplied,
        pull_request_closed: result.sideEffects.pullRequestClosed,
        human_review_requested: result.sideEffects.humanReviewRequested
      },
      dry_run: result.actionReport.config.dryRun,
      reason: result.actionReport.decision.reason
    };

    core.setOutput('decision', reportPayload.decision);
    core.setOutput('score', String(reportPayload.score));
    core.setOutput('triggered_heuristics', reportPayload.triggered_heuristics.join(','));
    core.setOutput('report_json', JSON.stringify(reportPayload));

    await core.summary
      .addHeading('pr406 Report')
      .addRaw(`Decision: \`${reportPayload.decision}\``)
      .addEOL()
      .addRaw(`Score: \`${reportPayload.score}\` (threshold \`${reportPayload.threshold}\`)`)
      .addEOL()
      .addRaw(`Triggered heuristics: ${formatList(reportPayload.triggered_heuristics)}`)
      .addEOL()
      .addRaw(`Dry run: \`${String(reportPayload.dry_run)}\``)
      .addEOL()
      .addRaw(`Reason: ${reportPayload.reason}`)
      .addEOL()
      .write();

    core.info(`PR406_REPORT ${JSON.stringify(reportPayload)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error while running pr406.';
    core.setFailed(message);
  }
}

void run();
