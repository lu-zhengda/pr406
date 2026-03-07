import type { DecisionResult, Pr406Config, ScoreReport } from './types';

function hasOverrideToken(body: string, token: string): boolean {
  return body.toLowerCase().includes(token.toLowerCase());
}

export function evaluateDecision(config: Pr406Config, report: ScoreReport, body: string): DecisionResult {
  const overrideApplied = hasOverrideToken(body, config.humanOverrideToken);
  const wouldFlag = report.total >= config.threshold;

  if (overrideApplied) {
    return {
      decision: 'overridden',
      overrideApplied: true,
      overrideToken: config.humanOverrideToken,
      shouldLabel: false,
      shouldComment: false,
      shouldClose: false,
      shouldRequestHumanReview: false,
      wouldLabel: wouldFlag,
      wouldComment: wouldFlag,
      wouldClose: wouldFlag && config.closeOnTrigger,
      wouldRequestHumanReview: wouldFlag && config.requestHumanReview && !config.closeOnTrigger,
      reason: 'Override token present in PR description.'
    };
  }

  if (!wouldFlag) {
    return {
      decision: 'allow',
      overrideApplied: false,
      overrideToken: config.humanOverrideToken,
      shouldLabel: false,
      shouldComment: false,
      shouldClose: false,
      shouldRequestHumanReview: false,
      wouldLabel: false,
      wouldComment: false,
      wouldClose: false,
      wouldRequestHumanReview: false,
      reason: 'Score below configured threshold.'
    };
  }

  const shouldEnforce = !config.dryRun;
  const shouldClose = shouldEnforce && config.closeOnTrigger;
  const shouldRequestHumanReview = shouldEnforce && config.requestHumanReview && !config.closeOnTrigger;

  return {
    decision: 'flagged',
    overrideApplied: false,
    overrideToken: config.humanOverrideToken,
    shouldLabel: shouldEnforce,
    shouldComment: shouldEnforce,
    shouldClose,
    shouldRequestHumanReview,
    wouldLabel: true,
    wouldComment: true,
    wouldClose: config.closeOnTrigger,
    wouldRequestHumanReview: config.requestHumanReview && !config.closeOnTrigger,
    reason: config.dryRun
      ? 'Score exceeded threshold in dry-run mode; no enforcement applied.'
      : 'Score exceeded threshold; enforcement actions enabled.'
  };
}
