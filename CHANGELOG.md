# Changelog

## v0.1.1 - 2026-03-08

### Changed

- Updated Action metadata name to `ai-pr-406` for GitHub Marketplace uniqueness requirements.

## v0.1.0 - 2026-03-07

Initial release of `pr406` (heuristics-only).

### Added

- TypeScript GitHub Action with configurable PR heuristic scoring.
- Default repo config contract in `.github/pr406.yml`.
- Policy layer for dry-run, enforcement, idempotent label/comment, and optional close-on-trigger.
- Human override token flow (`[human-authored]`).
- Unit and integration test coverage for core decision logic.
- Calibration script and fixture dataset gate.
- Autonomous E2E harness with real sandbox repos and fork PR scenarios.
- Open-source governance docs (`LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`).

### Validation

- `npm run validate`: pass
- `npm audit --omit=dev`: 0 vulnerabilities
- Autonomous E2E loop: 3/3 consecutive green runs
