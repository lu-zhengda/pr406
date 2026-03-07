import fs from 'node:fs';
import path from 'node:path';

import { scorePullRequest } from '../../src/heuristics';
import type { PrContext } from '../../src/types';

interface CalibrationFixture {
  id: string;
  label: 'ai_slop' | 'legit';
  firstPr: boolean;
  wideSingleCommit: boolean;
  codeWithoutTests: boolean;
  genericCommit: boolean;
  fastFork: boolean;
  genericDescription: boolean;
  noPriorParticipation: boolean;
}

interface Metrics {
  total: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  precision: number;
  recall: number;
  falsePositiveRate: number;
}

const THRESHOLD = 7;
const MIN_PRECISION = 0.9;
const MAX_FPR = 0.1;
const MIN_FIXTURES = 40;

function buildContext(fixture: CalibrationFixture): PrContext {
  const fastForkSeconds = fixture.fastFork ? 30 : 360;

  const baseFiles = fixture.wideSingleCommit
    ? ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts']
    : ['src/a.ts', 'src/b.ts'];

  const files = baseFiles.map((filename) => ({
    filename,
    status: 'modified',
    additions: 3,
    deletions: 1,
    changes: 4
  }));

  if (!fixture.codeWithoutTests) {
    files.push({
      filename: 'tests/a.test.ts',
      status: 'modified',
      additions: 3,
      deletions: 0,
      changes: 3
    });
  }

  return {
    pullRequest: {
      number: 1,
      authorLogin: 'fixture-user',
      body: fixture.genericDescription
        ? 'This PR updates code and improves quality.'
        : 'Fix parser stability edge case and add deterministic regression coverage.',
      createdAt: '2026-03-07T12:10:00Z',
      headRepoCreatedAt: new Date(Date.parse('2026-03-07T12:10:00Z') - fastForkSeconds * 1000).toISOString(),
      headRepoFork: true,
      state: 'open',
      labels: []
    },
    files,
    commits: [
      {
        sha: 'fixture-sha',
        message: fixture.genericCommit
          ? 'Implement parser feature'
          : 'Normalize parser traversal and preserve AST invariants'
      }
    ],
    participation: {
      prCount: fixture.firstPr ? 1 : 3,
      issueCount: fixture.noPriorParticipation ? 0 : 2,
      discussionCount: fixture.noPriorParticipation ? 0 : 1
    },
    warnings: []
  };
}

function computeMetrics(fixtures: CalibrationFixture[]): Metrics {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;

  for (const fixture of fixtures) {
    const report = scorePullRequest(buildContext(fixture), THRESHOLD);
    const predicted = report.total >= THRESHOLD ? 'ai_slop' : 'legit';

    if (fixture.label === 'ai_slop' && predicted === 'ai_slop') {
      truePositive += 1;
    } else if (fixture.label === 'legit' && predicted === 'ai_slop') {
      falsePositive += 1;
    } else if (fixture.label === 'legit' && predicted === 'legit') {
      trueNegative += 1;
    } else {
      falseNegative += 1;
    }
  }

  const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);
  const falsePositiveRate = falsePositive + trueNegative === 0 ? 0 : falsePositive / (falsePositive + trueNegative);

  return {
    total: fixtures.length,
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
    precision,
    recall,
    falsePositiveRate
  };
}

function main(): void {
  const fixturePath = path.join(process.cwd(), 'fixtures', 'calibration', 'dataset.json');
  const raw = fs.readFileSync(fixturePath, 'utf8');
  const fixtures = JSON.parse(raw) as CalibrationFixture[];

  if (fixtures.length < MIN_FIXTURES) {
    throw new Error(`Calibration corpus too small: expected >= ${MIN_FIXTURES}, got ${fixtures.length}.`);
  }

  const metrics = computeMetrics(fixtures);
  const pass = metrics.precision >= MIN_PRECISION && metrics.falsePositiveRate <= MAX_FPR;

  const output = {
    timestamp: new Date().toISOString(),
    threshold: THRESHOLD,
    min_precision: MIN_PRECISION,
    max_false_positive_rate: MAX_FPR,
    metrics,
    pass
  };

  fs.mkdirSync(path.join(process.cwd(), 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'artifacts', 'calibration-summary.json'), JSON.stringify(output, null, 2));

  console.log(JSON.stringify(output, null, 2));

  if (!pass) {
    process.exit(1);
  }
}

main();
