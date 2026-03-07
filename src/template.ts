import { COMMENT_MARKER } from './constants';
import type { DecisionResult, ScoreReport } from './types';

function tokenJoin(values: string[]): string {
  if (values.length === 0) {
    return 'none';
  }
  return values.map((value) => `\`${value}\``).join(', ');
}

function replaceTemplate(template: string, replacements: Record<string, string>): string {
  let output = template;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.split(`{{${key}}}`).join(value);
  }
  return output;
}

export function renderResponseTemplate(
  template: string,
  report: ScoreReport,
  decision: DecisionResult
): string {
  const rendered = replaceTemplate(template, {
    score: String(report.total),
    threshold: String(report.threshold),
    decision: decision.decision,
    triggered_heuristics: tokenJoin(report.triggeredHeuristics),
    override_token: decision.overrideToken,
    reason: decision.reason
  });

  if (rendered.includes(COMMENT_MARKER)) {
    return rendered;
  }

  return `${COMMENT_MARKER}\n\n${rendered}`;
}

export function includesCommentMarker(body: string | null): boolean {
  if (!body) {
    return false;
  }
  return body.includes(COMMENT_MARKER);
}
