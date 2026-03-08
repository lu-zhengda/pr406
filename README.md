# pr406

[![Release](https://img.shields.io/github/v/release/lu-zhengda/pr406?sort=semver)](https://github.com/lu-zhengda/pr406/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/lu-zhengda/pr406/ci.yml?branch=main&label=ci)](https://github.com/lu-zhengda/pr406/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/lu-zhengda/pr406)](https://github.com/lu-zhengda/pr406/blob/main/LICENSE)

`pr406` is a GitHub Action that scores pull requests with transparent structural heuristics and applies a standardized 406-style maintainer response when a configurable threshold is exceeded.

## What It Detects (v0.1)

The action scores these heuristics:

- first PR from contributor (+1)
- single commit touching more than 5 files (+2)
- code changes without test changes (+2)
- generic commit message pattern (+1)
- fork-to-PR time under 60 seconds (+3)
- generic/empty PR description (+1)
- no prior issue/discussion participation (+1)

Default threshold: `7`.

## Safe Defaults

- `dry_run: true` by default
- no auto-close unless explicitly enabled
- contributor override token: `[human-authored]`
- fail-open behavior when a signal cannot be fetched

## Install and Use

1. Add this workflow in your target repository at `.github/workflows/pr406.yml`:

```yaml
name: pr406

on:
  pull_request_target:
    types: [opened, reopened, synchronize, edited]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  pr406:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.ref }}
      - uses: lu-zhengda/pr406@v0.1.1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          config_path: .github/pr406.yml
```

2. Add config at `.github/pr406.yml`:

```yaml
threshold: 7
dry_run: true
close_on_trigger: false
```

3. Start with `dry_run: true` for at least a week, then switch to enforcement.

4. If you publish this action under your own account, replace `lu-zhengda/pr406` with your own `<owner>/<repo>`.

Copy-paste examples are included here:

- `examples/workflows/pr406.yml`
- `examples/pr406.yml`

## Should We Publish a Workflow?

No additional workflow package is required.

This repository publishes the Action. Each consuming repository adds its own workflow file that uses this Action reference (`uses: lu-zhengda/pr406@v0.1.1`).

## Config Reference

```yaml
threshold: 7
dry_run: true
label: ai-generated
close_on_trigger: false
request_human_review: false
human_override_token: "[human-authored]"
response_template: |
  <!-- pr406:comment-v1 -->
  ...
```

## Outputs

- `decision`: `allow` | `flagged` | `overridden`
- `score`: numeric total
- `triggered_heuristics`: comma-separated ids
- `report_json`: complete structured report

## Tuning Guide

- Keep `dry_run: true` for at least one week.
- Review false positives by checking `report_json` in job logs.
- Raise `threshold` if too many legitimate PRs are flagged.
- Enable `close_on_trigger` only after low false-positive confidence.

## Human Override

Contributors can add `[human-authored]` to the PR description. This suppresses automated enforcement and records decision `overridden`.

## Autonomous E2E Validation

Run the complete autonomous loop (3 consecutive green iterations):

```bash
E2E_OWNER=... E2E_CONTRIBUTOR=... GH_MAINTAINER_TOKEN=... GH_CONTRIB_TOKEN=... npm run e2e
```

Artifacts:

- `artifacts/e2e/latest-summary.json`
- `artifacts/e2e/latest-log.md`

## Development

```bash
npm ci
npm run validate
```

`npm run validate` executes lint, typecheck, tests, build, and calibration gate checks.

## Project Policies

- Security reporting: `SECURITY.md`
- Contribution guide: `CONTRIBUTING.md`
- Community conduct: `CODE_OF_CONDUCT.md`
- License: `LICENSE` (MIT)
