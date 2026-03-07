import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

interface CommandResult {
  stdout: string;
  stderr: string;
  status: number;
}

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  allowFailure?: boolean;
}

interface ScenarioResult {
  name: string;
  passed: boolean;
  details: string;
}

interface LoopResult {
  iteration: number;
  passed: boolean;
  repo: string;
  scenarios: ScenarioResult[];
  errors: string[];
}

interface PrReport {
  decision: 'allow' | 'flagged' | 'overridden';
  score: number;
  threshold: number;
  triggered_heuristics: string[];
  warnings: string[];
  side_effects: {
    label_applied: boolean;
    comment_applied: boolean;
    pull_request_closed: boolean;
    human_review_requested: boolean;
  };
  dry_run: boolean;
  reason: string;
}

interface PrView {
  state: string;
  labels: Array<{ name: string }>;
  comments: Array<{ body: string | null }>;
}

interface RepoRecord {
  name: string;
  createdAt: string;
}

interface GitAuth {
  username: string;
  token: string;
}

const OWNER = process.env.E2E_OWNER ?? 'E2E_OWNER_REQUIRED';
const CONTRIBUTOR = process.env.E2E_CONTRIBUTOR ?? 'E2E_CONTRIBUTOR_REQUIRED';
const COMMENT_MARKER = '<!-- pr406:comment-v1 -->';
const REQUIRED_CONSECUTIVE_GREEN = 3;
const FAILED_REPO_RETENTION_HOURS = 24;
const ARTIFACT_DIR = path.join(process.cwd(), 'artifacts', 'e2e');
const LOG_LINES: string[] = [];
const REDACTION_PATTERNS = [
  process.env.GH_MAINTAINER_TOKEN ?? '',
  process.env.GH_CONTRIB_TOKEN ?? ''
].filter((value) => value.length > 0);

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  LOG_LINES.push(line);
  console.log(line);
}

function sanitize(text: string): string {
  let output = text;
  for (const pattern of REDACTION_PATTERNS) {
    if (pattern.length > 0) {
      output = output.split(pattern).join('***');
    }
  }

  return output.replace(/gho_[a-zA-Z0-9_]+/g, 'gho_***');
}

function run(command: string, args: string[], options: RunOptions = {}): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.env ?? {})
    },
    encoding: 'utf8'
  });

  const status = result.status ?? 1;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (status !== 0 && !options.allowFailure) {
    throw new Error(
      `Command failed (${command}):\nSTDOUT:\n${sanitize(stdout)}\nSTDERR:\n${sanitize(stderr)}`
    );
  }

  return {
    stdout,
    stderr,
    status
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}

function configYaml(options: {
  dryRun: boolean;
  closeOnTrigger: boolean;
  requestHumanReview?: boolean;
  threshold?: number;
}): string {
  const threshold = options.threshold ?? 7;
  const requestHumanReview = options.requestHumanReview ?? false;

  return [
    `threshold: ${threshold}`,
    `dry_run: ${String(options.dryRun)}`,
    'label: ai-generated',
    `close_on_trigger: ${String(options.closeOnTrigger)}`,
    `request_human_review: ${String(requestHumanReview)}`,
    'human_override_token: "[human-authored]"',
    'response_template: |',
    `  ${COMMENT_MARKER}`,
    '  ',
    '  406 Not Acceptable: automated heuristic signal triggered.',
    '  ',
    '  - Score: `{{score}} / threshold {{threshold}}`',
    '  - Triggered heuristics: {{triggered_heuristics}}',
    '  - Decision: `{{decision}}`',
    '  ',
    '  Add `{{override_token}}` to the PR description if this is human-authored.'
  ].join('\n');
}

function workflowYaml(): string {
  return [
    'name: pr406-check',
    '',
    'on:',
    '  pull_request_target:',
    '    types: [opened, reopened, synchronize, edited]',
    '',
    'permissions:',
    '  contents: read',
    '  pull-requests: write',
    '  issues: write',
    '',
    'jobs:',
    '  pr406:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Checkout base ref',
    '        uses: actions/checkout@v4',
    '        with:',
    '          ref: ${{ github.event.pull_request.base.ref }}',
    '      - name: Run pr406',
    '        id: pr406',
    '        uses: ./.github/actions/pr406',
    '        with:',
    '          github_token: ${{ secrets.GITHUB_TOKEN }}',
    '          config_path: .github/pr406.yml',
    '      - name: Emit JSON report',
    "        run: printf '%s\\n' '${{ steps.pr406.outputs.report_json }}'"
  ].join('\n');
}

function copyActionBundle(targetRepoPath: string): void {
  const actionTargetDir = path.join(targetRepoPath, '.github', 'actions', 'pr406');
  ensureDir(actionTargetDir);

  const sourceActionYml = path.join(process.cwd(), 'action.yml');
  const sourceDist = path.join(process.cwd(), 'dist');

  if (!fs.existsSync(sourceDist)) {
    throw new Error('dist/ is missing. Run npm run build before e2e execution.');
  }

  fs.copyFileSync(sourceActionYml, path.join(actionTargetDir, 'action.yml'));

  ensureDir(path.join(actionTargetDir, 'dist'));
  const files = fs.readdirSync(sourceDist);
  for (const file of files) {
    fs.copyFileSync(path.join(sourceDist, file), path.join(actionTargetDir, 'dist', file));
  }
}

function runLocalValidation(): void {
  log('Running local validation: lint, typecheck, tests, build, calibrate.');
  run('npm', ['run', 'build']);
  run('npm', ['run', 'calibrate']);
}

function gitSetup(cwd: string, name: string, email: string): void {
  run('git', ['config', 'user.name', name], { cwd });
  run('git', ['config', 'user.email', email], { cwd });
}

function ensureAskPassScript(): string {
  const scriptDir = path.join(process.cwd(), '.tmp', 'credentials');
  const scriptPath = path.join(scriptDir, 'git-askpass.sh');

  if (fs.existsSync(scriptPath)) {
    return scriptPath;
  }

  ensureDir(scriptDir);
  const scriptContent = [
    '#!/usr/bin/env sh',
    'case \"$1\" in',
    '  *Username*) printf \"%s\" \"$GIT_USERNAME\" ;;',
    '  *Password*) printf \"%s\" \"$GIT_PASSWORD\" ;;',
    '  *) printf \"\" ;;',
    'esac'
  ].join('\n');

  fs.writeFileSync(scriptPath, scriptContent, { mode: 0o700 });
  return scriptPath;
}

function runGitWithForcedAuth(cwd: string, args: string[], auth: GitAuth): CommandResult {
  const askPassPath = ensureAskPassScript();
  return run('git', ['-c', 'credential.helper=', '-c', `core.askPass=${askPassPath}`, ...args], {
    cwd,
    env: {
      GIT_ASKPASS: askPassPath,
      GIT_TERMINAL_PROMPT: '0',
      GIT_USERNAME: auth.username,
      GIT_PASSWORD: auth.token
    }
  });
}

function ensureGitRemote(cwd: string, name: string, url: string): void {
  const existing = run('git', ['remote'], { cwd }).stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (existing.includes(name)) {
    run('git', ['remote', 'set-url', name, url], { cwd });
    return;
  }

  run('git', ['remote', 'add', name, url], { cwd });
}

function gitCommitAll(cwd: string, message: string): void {
  run('git', ['add', '.'], { cwd });
  const status = run('git', ['status', '--porcelain'], { cwd });
  if (status.stdout.trim().length === 0) {
    return;
  }
  run('git', ['commit', '-m', message], { cwd });
}

async function grantContributorCollaboratorAccess(
  repoName: string,
  maintainerToken: string,
  contributorToken: string
): Promise<void> {
  const repoFullName = `${OWNER}/${repoName}`;
  log(`Granting collaborator access to ${CONTRIBUTOR} on ${repoFullName}.`);

  run(
    'gh',
    [
      'api',
      '--method',
      'PUT',
      `repos/${OWNER}/${repoName}/collaborators/${CONTRIBUTOR}`,
      '-f',
      'permission=push'
    ],
    {
      env: { GH_TOKEN: maintainerToken }
    }
  );

  const deadline = Date.now() + 60_000;
  let acceptedInvitation = false;

  while (Date.now() < deadline) {
    const invitationId = run(
      'gh',
      [
        'api',
        'user/repository_invitations',
        '--jq',
        `.[] | select(.repository.full_name == "${repoFullName}") | .id`
      ],
      {
        env: { GH_TOKEN: contributorToken }
      }
    ).stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);

    if (invitationId) {
      run('gh', ['api', '--method', 'PATCH', `user/repository_invitations/${invitationId}`], {
        env: { GH_TOKEN: contributorToken }
      });
      acceptedInvitation = true;
      log(`Accepted collaborator invitation ${invitationId} for ${repoFullName}.`);
      break;
    }

    await sleep(2000);
  }

  if (!acceptedInvitation) {
    throw new Error(`Timed out waiting for collaborator invitation for ${repoFullName}.`);
  }

  const permission = run(
    'gh',
    ['api', `repos/${OWNER}/${repoName}/collaborators/${CONTRIBUTOR}/permission`, '--jq', '.permission'],
    {
      env: { GH_TOKEN: maintainerToken }
    }
  ).stdout.trim();

  if (!['write', 'admin', 'maintain'].includes(permission)) {
    throw new Error(
      `Contributor ${CONTRIBUTOR} lacks write access on ${repoFullName}. Permission: ${permission || 'unknown'}`
    );
  }
}

async function createSandboxRepo(
  repoName: string,
  maintainerToken: string,
  contributorToken: string
): Promise<void> {
  log(`Creating sandbox repository ${OWNER}/${repoName}.`);
  run(
    'gh',
    ['repo', 'create', `${OWNER}/${repoName}`, '--public', '--confirm', '--description', 'pr406 automated e2e sandbox'],
    {
      env: { GH_TOKEN: maintainerToken }
    }
  );

  run(
    'gh',
    [
      'api',
      '--method',
      'PUT',
      `repos/${OWNER}/${repoName}/actions/permissions/fork-pr-contributor-approval`,
      '-f',
      'approval_policy=first_time_contributors_new_to_github'
    ],
    {
      env: { GH_TOKEN: maintainerToken }
    }
  );

  await grantContributorCollaboratorAccess(repoName, maintainerToken, contributorToken);
}

function cloneRepo(repoFullName: string, targetDir: string, token: string): void {
  run('gh', ['repo', 'clone', repoFullName, targetDir], {
    env: { GH_TOKEN: token }
  });
}

function listSandboxRepos(owner: string, token: string): RepoRecord[] {
  const repos: RepoRecord[] = [];
  let page = 1;

  while (true) {
    const response = run(
      'gh',
      [
        'api',
        `users/${owner}/repos?type=owner&sort=created&direction=desc&per_page=100&page=${page}`,
        '--jq',
        '.[] | {name: .name, createdAt: .created_at}'
      ],
      {
        env: { GH_TOKEN: token }
      }
    ).stdout;

    const allRows = response
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as RepoRecord);

    const rows = allRows
      .filter((repo) => repo.name.startsWith('pr406-e2e-'));

    repos.push(...rows);

    if (allRows.length < 100) {
      break;
    }

    page += 1;
  }

  return repos;
}

function cleanupStaleSandboxRepos(maintainerToken: string, contributorToken: string): void {
  const cutoffMs = Date.now() - FAILED_REPO_RETENTION_HOURS * 60 * 60 * 1000;

  const candidates = [
    { owner: OWNER, token: maintainerToken },
    { owner: CONTRIBUTOR, token: contributorToken }
  ];

  for (const candidate of candidates) {
    const repos = listSandboxRepos(candidate.owner, candidate.token);
    for (const repo of repos) {
      const createdAtMs = Date.parse(repo.createdAt);
      if (Number.isNaN(createdAtMs) || createdAtMs > cutoffMs) {
        continue;
      }

      log(`Deleting stale sandbox repository ${candidate.owner}/${repo.name}.`);
      run('gh', ['repo', 'delete', `${candidate.owner}/${repo.name}`, '--yes'], {
        env: { GH_TOKEN: candidate.token },
        allowFailure: true
      });
    }
  }
}

function pushMain(cwd: string, auth: GitAuth): void {
  runGitWithForcedAuth(cwd, ['push', 'origin', 'main'], auth);
}

function syncMainFromOrigin(cwd: string, auth: GitAuth): void {
  runGitWithForcedAuth(cwd, ['fetch', 'origin', 'main'], auth);
  run('git', ['checkout', 'main'], { cwd });
  runGitWithForcedAuth(cwd, ['pull', '--ff-only', 'origin', 'main'], auth);
}

function updateConfigInBaseRepo(baseRepoPath: string, content: string, maintainerAuth: GitAuth, message: string): void {
  syncMainFromOrigin(baseRepoPath, maintainerAuth);
  writeFile(path.join(baseRepoPath, '.github', 'pr406.yml'), content);
  gitCommitAll(baseRepoPath, message);
  runGitWithForcedAuth(baseRepoPath, ['push', 'origin', 'main'], maintainerAuth);
}

function initializeSandboxRepo(baseRepoPath: string, maintainerAuth: GitAuth): void {
  gitSetup(baseRepoPath, 'pr406 bot', 'pr406-bot@example.com');

  copyActionBundle(baseRepoPath);
  writeFile(path.join(baseRepoPath, '.github', 'workflows', 'pr406-check.yml'), workflowYaml());
  writeFile(path.join(baseRepoPath, '.github', 'pr406.yml'), configYaml({ dryRun: true, closeOnTrigger: false }));

  writeFile(path.join(baseRepoPath, 'src', 'core.ts'), 'export const value = 1;\n');
  writeFile(path.join(baseRepoPath, 'tests', 'core.test.ts'), 'export const testValue = 1;\n');
  writeFile(path.join(baseRepoPath, 'README.md'), '# sandbox\n');

  gitCommitAll(baseRepoPath, 'Initialize pr406 sandbox');
  pushMain(baseRepoPath, maintainerAuth);
}

function ensureContributorFork(repoName: string, contributorToken: string): void {
  run('gh', ['repo', 'fork', `${OWNER}/${repoName}`, '--clone=false', '--remote=false'], {
    env: { GH_TOKEN: contributorToken }
  });
}

function syncForkMain(contributorRepoPath: string, contributorAuth: GitAuth): void {
  runGitWithForcedAuth(contributorRepoPath, ['fetch', 'upstream', 'main'], contributorAuth);
  run('git', ['checkout', 'main'], { cwd: contributorRepoPath });
  run('git', ['merge', '--ff-only', 'upstream/main'], { cwd: contributorRepoPath });
  runGitWithForcedAuth(contributorRepoPath, ['push', 'origin', 'main'], contributorAuth);
}

function createBranch(cwd: string, branchName: string): void {
  run('git', ['checkout', '-B', branchName], { cwd });
}

function createBotLikeChanges(cwd: string): void {
  writeFile(path.join(cwd, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFile(path.join(cwd, 'src', 'b.ts'), 'export const b = 1;\n');
  writeFile(path.join(cwd, 'src', 'c.ts'), 'export const c = 1;\n');
  writeFile(path.join(cwd, 'src', 'd.ts'), 'export const d = 1;\n');
  writeFile(path.join(cwd, 'src', 'e.ts'), 'export const e = 1;\n');
  writeFile(path.join(cwd, 'src', 'f.ts'), 'export const f = 1;\n');
}

function createLegitChanges(cwd: string): void {
  writeFile(path.join(cwd, 'src', 'core.ts'), 'export const value = 2;\n');
  writeFile(path.join(cwd, 'tests', 'core.test.ts'), 'export const testValue = 2;\n');
}

function pushBranch(cwd: string, branchName: string, auth: GitAuth): void {
  runGitWithForcedAuth(cwd, ['push', '-u', 'origin', branchName, '--force-with-lease'], auth);
}

function createPr(args: {
  repo: string;
  token: string;
  head: string;
  base: string;
  title: string;
  body: string;
}): number {
  const output = run(
    'gh',
    ['pr', 'create', '--repo', args.repo, '--head', args.head, '--base', args.base, '--title', args.title, '--body', args.body],
    {
      env: { GH_TOKEN: args.token }
    }
  );

  const url = output.stdout.trim().split('\n').find((line) => line.includes('/pull/'));
  if (!url) {
    throw new Error(`Unable to parse PR URL from output: ${output.stdout}`);
  }

  const match = url.match(/\/pull\/(\d+)/);
  if (!match) {
    throw new Error(`Unable to parse PR number from URL: ${url}`);
  }

  return Number(match[1]);
}

function getPrView(repo: string, prNumber: number, token: string): PrView {
  const response = run('gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'state,labels,comments'], {
    env: { GH_TOKEN: token }
  });

  return JSON.parse(response.stdout) as PrView;
}

function findLabel(prView: PrView, label: string): boolean {
  return prView.labels.some((item) => item.name === label);
}

function has406Comment(prView: PrView): boolean {
  return prView.comments.some((comment) => (comment.body ?? '').includes(COMMENT_MARKER));
}

function getRunList(repo: string, token: string): Array<{
  databaseId: number;
  headBranch: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
}> {
  const response = run(
    'gh',
    [
      'run',
      'list',
      '--repo',
      repo,
      '--workflow',
      'pr406-check.yml',
      '--event',
      'pull_request_target',
      '--json',
      'databaseId,headBranch,status,conclusion,createdAt',
      '--limit',
      '30'
    ],
    {
      env: { GH_TOKEN: token }
    }
  );

  return JSON.parse(response.stdout) as Array<{
    databaseId: number;
    headBranch: string;
    status: string;
    conclusion: string | null;
    createdAt: string;
  }>;
}

async function waitForRunAndReport(args: {
  repo: string;
  branch: string;
  token: string;
  startedAtMs: number;
}): Promise<{ report: PrReport; runId: number }> {
  const timeoutMs = 15 * 60 * 1000;
  const pollMs = 5000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const runs = getRunList(args.repo, args.token);
    const runMatch = runs.find((runItem) => {
      const createdAtMs = Date.parse(runItem.createdAt);
      return runItem.headBranch === args.branch && createdAtMs >= args.startedAtMs - 10000;
    });

    if (runMatch) {
      run('gh', ['run', 'watch', String(runMatch.databaseId), '--repo', args.repo, '--interval', '5'], {
        env: { GH_TOKEN: args.token },
        allowFailure: true
      });

      const runLog = run('gh', ['run', 'view', String(runMatch.databaseId), '--repo', args.repo, '--log'], {
        env: { GH_TOKEN: args.token }
      }).stdout;

      const line = runLog
        .split('\n')
        .map((item) => item.trim())
        .find((item) => item.includes('PR406_REPORT '));

      if (!line) {
        throw new Error(`Workflow log did not contain PR406_REPORT marker for run ${runMatch.databaseId}.`);
      }

      const marker = line.slice(line.indexOf('PR406_REPORT ') + 'PR406_REPORT '.length);
      const report = JSON.parse(marker) as PrReport;

      return {
        report,
        runId: runMatch.databaseId
      };
    }

    await sleep(pollMs);
  }

  throw new Error(`Timed out waiting for workflow run on branch ${args.branch}.`);
}

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function runScenarioDryRunHighRisk(args: {
  repoName: string;
  baseRepoPath: string;
  contributorRepoPath: string;
  maintainerToken: string;
  contributorToken: string;
}): Promise<ScenarioResult> {
  const scenarioName = 'dryrun_high_risk_first_pr';

  try {
    updateConfigInBaseRepo(
      args.baseRepoPath,
      configYaml({ dryRun: true, closeOnTrigger: false }),
      { username: OWNER, token: args.maintainerToken },
      'Set dry-run config'
    );

    syncForkMain(args.contributorRepoPath, { username: CONTRIBUTOR, token: args.contributorToken });
    const branch = `scenario-${scenarioName}`;
    createBranch(args.contributorRepoPath, branch);
    createBotLikeChanges(args.contributorRepoPath);
    gitCommitAll(args.contributorRepoPath, 'Implement parser feature');
    pushBranch(args.contributorRepoPath, branch, { username: CONTRIBUTOR, token: args.contributorToken });

    const startedAt = Date.now();
    const prNumber = createPr({
      repo: `${OWNER}/${args.repoName}`,
      token: args.contributorToken,
      head: `${CONTRIBUTOR}:${branch}`,
      base: 'main',
      title: 'Implement parser feature',
      body: ''
    });

    const { report } = await waitForRunAndReport({
      repo: `${OWNER}/${args.repoName}`,
      branch,
      token: args.maintainerToken,
      startedAtMs: startedAt
    });

    const prView = getPrView(`${OWNER}/${args.repoName}`, prNumber, args.maintainerToken);

    assertCondition(report.decision === 'flagged', 'Expected flagged decision in dry-run high-risk scenario.');
    assertCondition(report.dry_run === true, 'Expected dry_run=true in dry-run scenario.');
    assertCondition(!findLabel(prView, 'ai-generated'), 'Did not expect ai-generated label in dry-run mode.');
    assertCondition(!has406Comment(prView), 'Did not expect 406 comment in dry-run mode.');
    assertCondition(prView.state === 'OPEN', 'Did not expect PR to close in dry-run mode.');

    return {
      name: scenarioName,
      passed: true,
      details: `PR #${prNumber} passed.`
    };
  } catch (error) {
    return {
      name: scenarioName,
      passed: false,
      details: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

async function runScenarioEnforceHighRiskReturning(args: {
  repoName: string;
  baseRepoPath: string;
  contributorRepoPath: string;
  maintainerToken: string;
  contributorToken: string;
}): Promise<ScenarioResult> {
  const scenarioName = 'enforce_high_risk_returning_contributor';

  try {
    updateConfigInBaseRepo(
      args.baseRepoPath,
      configYaml({ dryRun: false, closeOnTrigger: false }),
      { username: OWNER, token: args.maintainerToken },
      'Set enforce mode without auto-close'
    );

    syncForkMain(args.contributorRepoPath, { username: CONTRIBUTOR, token: args.contributorToken });
    const branch = `scenario-${scenarioName}`;
    createBranch(args.contributorRepoPath, branch);
    createBotLikeChanges(args.contributorRepoPath);
    gitCommitAll(args.contributorRepoPath, 'Implement translation feature');
    pushBranch(args.contributorRepoPath, branch, { username: CONTRIBUTOR, token: args.contributorToken });

    const startedAt = Date.now();
    const prNumber = createPr({
      repo: `${OWNER}/${args.repoName}`,
      token: args.contributorToken,
      head: `${CONTRIBUTOR}:${branch}`,
      base: 'main',
      title: 'Implement translation feature',
      body: 'This PR updates files.'
    });

    const { report } = await waitForRunAndReport({
      repo: `${OWNER}/${args.repoName}`,
      branch,
      token: args.maintainerToken,
      startedAtMs: startedAt
    });

    const prView = getPrView(`${OWNER}/${args.repoName}`, prNumber, args.maintainerToken);

    assertCondition(report.decision === 'flagged', 'Expected flagged decision in enforce scenario.');
    assertCondition(report.dry_run === false, 'Expected dry_run=false in enforce scenario.');
    assertCondition(findLabel(prView, 'ai-generated'), 'Expected ai-generated label in enforce scenario.');
    assertCondition(has406Comment(prView), 'Expected 406 comment in enforce scenario.');
    assertCondition(prView.state === 'OPEN', 'Did not expect PR close when close_on_trigger=false.');
    assertCondition(
      !report.triggered_heuristics.includes('first_pr'),
      'Expected first_pr heuristic not to trigger for returning contributor.'
    );

    return {
      name: scenarioName,
      passed: true,
      details: `PR #${prNumber} passed.`
    };
  } catch (error) {
    return {
      name: scenarioName,
      passed: false,
      details: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

async function runScenarioLegitFirstTimeMaintainer(args: {
  repoName: string;
  baseRepoPath: string;
  maintainerToken: string;
}): Promise<ScenarioResult> {
  const scenarioName = 'legit_first_time_not_flagged';

  try {
    updateConfigInBaseRepo(
      args.baseRepoPath,
      configYaml({ dryRun: false, closeOnTrigger: false }),
      { username: OWNER, token: args.maintainerToken },
      'Keep enforce config for legit scenario'
    );

    const branch = `scenario-${scenarioName}`;
    createBranch(args.baseRepoPath, branch);
    createLegitChanges(args.baseRepoPath);
    gitCommitAll(args.baseRepoPath, 'Fix parser edge case and add regression test');
    pushBranch(args.baseRepoPath, branch, { username: OWNER, token: args.maintainerToken });

    const startedAt = Date.now();
    const prNumber = createPr({
      repo: `${OWNER}/${args.repoName}`,
      token: args.maintainerToken,
      head: branch,
      base: 'main',
      title: 'Fix parser edge case and add regression test',
      body: 'This change addresses parser state drift and includes matching test updates.'
    });

    const { report } = await waitForRunAndReport({
      repo: `${OWNER}/${args.repoName}`,
      branch,
      token: args.maintainerToken,
      startedAtMs: startedAt
    });

    const prView = getPrView(`${OWNER}/${args.repoName}`, prNumber, args.maintainerToken);

    assertCondition(report.decision === 'allow', 'Expected allow decision for legitimate PR scenario.');
    assertCondition(!findLabel(prView, 'ai-generated'), 'Did not expect ai-generated label on legitimate PR.');
    assertCondition(!has406Comment(prView), 'Did not expect 406 comment on legitimate PR.');

    return {
      name: scenarioName,
      passed: true,
      details: `PR #${prNumber} passed.`
    };
  } catch (error) {
    return {
      name: scenarioName,
      passed: false,
      details: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

async function runScenarioOverrideToken(args: {
  repoName: string;
  baseRepoPath: string;
  contributorRepoPath: string;
  maintainerToken: string;
  contributorToken: string;
}): Promise<ScenarioResult> {
  const scenarioName = 'override_token_suppresses_enforcement';

  try {
    updateConfigInBaseRepo(
      args.baseRepoPath,
      configYaml({ dryRun: false, closeOnTrigger: false }),
      { username: OWNER, token: args.maintainerToken },
      'Set enforce config for override scenario'
    );

    syncForkMain(args.contributorRepoPath, { username: CONTRIBUTOR, token: args.contributorToken });
    const branch = `scenario-${scenarioName}`;
    createBranch(args.contributorRepoPath, branch);
    createBotLikeChanges(args.contributorRepoPath);
    gitCommitAll(args.contributorRepoPath, 'Implement logging feature');
    pushBranch(args.contributorRepoPath, branch, { username: CONTRIBUTOR, token: args.contributorToken });

    const startedAt = Date.now();
    const prNumber = createPr({
      repo: `${OWNER}/${args.repoName}`,
      token: args.contributorToken,
      head: `${CONTRIBUTOR}:${branch}`,
      base: 'main',
      title: 'Implement logging feature',
      body: '[human-authored] I wrote this manually.'
    });

    const { report } = await waitForRunAndReport({
      repo: `${OWNER}/${args.repoName}`,
      branch,
      token: args.maintainerToken,
      startedAtMs: startedAt
    });

    const prView = getPrView(`${OWNER}/${args.repoName}`, prNumber, args.maintainerToken);

    assertCondition(report.decision === 'overridden', 'Expected overridden decision when override token is present.');
    assertCondition(!findLabel(prView, 'ai-generated'), 'Did not expect ai-generated label when override token is present.');
    assertCondition(!has406Comment(prView), 'Did not expect 406 comment when override token is present.');
    assertCondition(prView.state === 'OPEN', 'Did not expect PR closure in override scenario.');

    return {
      name: scenarioName,
      passed: true,
      details: `PR #${prNumber} passed.`
    };
  } catch (error) {
    return {
      name: scenarioName,
      passed: false,
      details: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

async function runScenarioCloseOnTrigger(args: {
  repoName: string;
  baseRepoPath: string;
  contributorRepoPath: string;
  maintainerToken: string;
  contributorToken: string;
}): Promise<ScenarioResult> {
  const scenarioName = 'enforce_close_on_trigger';

  try {
    updateConfigInBaseRepo(
      args.baseRepoPath,
      configYaml({ dryRun: false, closeOnTrigger: true }),
      { username: OWNER, token: args.maintainerToken },
      'Enable close_on_trigger'
    );

    syncForkMain(args.contributorRepoPath, { username: CONTRIBUTOR, token: args.contributorToken });
    const branch = `scenario-${scenarioName}`;
    createBranch(args.contributorRepoPath, branch);
    createBotLikeChanges(args.contributorRepoPath);
    gitCommitAll(args.contributorRepoPath, 'Implement metrics feature');
    pushBranch(args.contributorRepoPath, branch, { username: CONTRIBUTOR, token: args.contributorToken });

    const startedAt = Date.now();
    const prNumber = createPr({
      repo: `${OWNER}/${args.repoName}`,
      token: args.contributorToken,
      head: `${CONTRIBUTOR}:${branch}`,
      base: 'main',
      title: 'Implement metrics feature',
      body: 'This PR updates files.'
    });

    const { report } = await waitForRunAndReport({
      repo: `${OWNER}/${args.repoName}`,
      branch,
      token: args.maintainerToken,
      startedAtMs: startedAt
    });

    const prView = getPrView(`${OWNER}/${args.repoName}`, prNumber, args.maintainerToken);

    assertCondition(report.decision === 'flagged', 'Expected flagged decision in close-on-trigger scenario.');
    assertCondition(findLabel(prView, 'ai-generated'), 'Expected ai-generated label in close-on-trigger scenario.');
    assertCondition(has406Comment(prView), 'Expected 406 comment in close-on-trigger scenario.');
    assertCondition(prView.state === 'CLOSED', 'Expected PR to be closed when close_on_trigger=true.');

    return {
      name: scenarioName,
      passed: true,
      details: `PR #${prNumber} passed.`
    };
  } catch (error) {
    return {
      name: scenarioName,
      passed: false,
      details: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

async function runSingleLoop(iteration: number, maintainerToken: string, contributorToken: string): Promise<LoopResult> {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const repoName = `pr406-e2e-${runId}`;
  const tempRoot = path.join(process.cwd(), '.tmp', `e2e-${runId}`);
  const baseRepoPath = path.join(tempRoot, 'base');
  const contributorRepoPath = path.join(tempRoot, 'contributor');

  ensureDir(tempRoot);

  const scenarios: ScenarioResult[] = [];
  const errors: string[] = [];

  try {
    runLocalValidation();

    await createSandboxRepo(repoName, maintainerToken, contributorToken);
    cloneRepo(`${OWNER}/${repoName}`, baseRepoPath, maintainerToken);
    initializeSandboxRepo(baseRepoPath, { username: OWNER, token: maintainerToken });

    ensureContributorFork(repoName, contributorToken);
    cloneRepo(`${CONTRIBUTOR}/${repoName}`, contributorRepoPath, contributorToken);
    ensureGitRemote(contributorRepoPath, 'upstream', `https://github.com/${OWNER}/${repoName}.git`);
    gitSetup(contributorRepoPath, 'e2e-contributor', 'e2e-contributor@example.com');

    scenarios.push(
      await runScenarioDryRunHighRisk({
        repoName,
        baseRepoPath,
        contributorRepoPath,
        maintainerToken,
        contributorToken
      })
    );

    scenarios.push(
      await runScenarioEnforceHighRiskReturning({
        repoName,
        baseRepoPath,
        contributorRepoPath,
        maintainerToken,
        contributorToken
      })
    );

    scenarios.push(
      await runScenarioLegitFirstTimeMaintainer({
        repoName,
        baseRepoPath,
        maintainerToken
      })
    );

    scenarios.push(
      await runScenarioOverrideToken({
        repoName,
        baseRepoPath,
        contributorRepoPath,
        maintainerToken,
        contributorToken
      })
    );

    scenarios.push(
      await runScenarioCloseOnTrigger({
        repoName,
        baseRepoPath,
        contributorRepoPath,
        maintainerToken,
        contributorToken
      })
    );

    const passed = scenarios.every((scenario) => scenario.passed);

    if (passed) {
      log(`Iteration ${iteration}: all scenarios passed. Cleaning up repositories.`);
      run('gh', ['repo', 'delete', `${OWNER}/${repoName}`, '--yes'], {
        env: { GH_TOKEN: maintainerToken },
        allowFailure: true
      });
      run('gh', ['repo', 'delete', `${CONTRIBUTOR}/${repoName}`, '--yes'], {
        env: { GH_TOKEN: contributorToken },
        allowFailure: true
      });
    } else {
      errors.push('One or more scenarios failed. Sandbox repositories retained for up to 24h.');
      log(`Iteration ${iteration}: scenario failure detected. Keeping ${OWNER}/${repoName} for debugging.`);
    }

    return {
      iteration,
      passed,
      repo: `${OWNER}/${repoName}`,
      scenarios,
      errors
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown loop failure';
    errors.push(message);
    log(`Iteration ${iteration} failed before completing scenario matrix: ${message}`);
    return {
      iteration,
      passed: false,
      repo: `${OWNER}/${repoName}`,
      scenarios,
      errors
    };
  }
}

function writeArtifacts(summary: {
  passed: boolean;
  loops: LoopResult[];
  startedAt: string;
  finishedAt: string;
}): void {
  ensureDir(ARTIFACT_DIR);
  writeFile(path.join(ARTIFACT_DIR, 'latest-summary.json'), JSON.stringify(summary, null, 2));
  writeFile(path.join(ARTIFACT_DIR, 'latest-log.md'), LOG_LINES.join('\n'));
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();

  if (OWNER === 'E2E_OWNER_REQUIRED' || CONTRIBUTOR === 'E2E_CONTRIBUTOR_REQUIRED') {
    throw new Error('Missing E2E_OWNER or E2E_CONTRIBUTOR environment variable.');
  }

  if (OWNER === CONTRIBUTOR) {
    throw new Error('E2E_OWNER and E2E_CONTRIBUTOR must be different GitHub accounts.');
  }

  const maintainerToken = requireEnv('GH_MAINTAINER_TOKEN');
  const contributorToken = requireEnv('GH_CONTRIB_TOKEN');

  cleanupStaleSandboxRepos(maintainerToken, contributorToken);

  log('Starting autonomous e2e validation loop.');
  const loops: LoopResult[] = [];

  for (let iteration = 1; iteration <= REQUIRED_CONSECUTIVE_GREEN; iteration += 1) {
    log(`Starting loop iteration ${iteration}/${REQUIRED_CONSECUTIVE_GREEN}.`);
    const loopResult = await runSingleLoop(iteration, maintainerToken, contributorToken);
    loops.push(loopResult);

    if (!loopResult.passed) {
      const summary = {
        passed: false,
        loops,
        startedAt,
        finishedAt: new Date().toISOString()
      };
      writeArtifacts(summary);
      throw new Error(`E2E loop failed in iteration ${iteration}.`);
    }
  }

  const summary = {
    passed: true,
    loops,
    startedAt,
    finishedAt: new Date().toISOString()
  };

  writeArtifacts(summary);
  log('All required consecutive loops passed. Workflow is ready to use.');
}

void main();
