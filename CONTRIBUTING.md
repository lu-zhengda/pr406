# Contributing

## Development setup

```bash
npm ci
npm run validate
```

`npm run validate` runs lint, typecheck, tests, build, and calibration checks.

## Pull request expectations

- Keep changes scoped and explain rationale in the PR description.
- Add or update tests for behavior changes.
- Avoid introducing secrets, tokens, or private data in code/tests/logs.

## Release notes for maintainers

This is a JavaScript GitHub Action (`runs.main: dist/index.js`).
For release tags, ensure `dist/index.js` is rebuilt and committed.
