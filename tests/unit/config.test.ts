import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/constants';
import { parseConfig } from '../../src/config';

describe('parseConfig', () => {
  it('parses valid YAML config', () => {
    const raw = [
      'threshold: 8',
      'dry_run: false',
      'label: ai-slop',
      'close_on_trigger: true',
      'request_human_review: false',
      'human_override_token: "[human-authored]"',
      'response_template: "hello {{score}}"'
    ].join('\n');

    const result = parseConfig(raw);

    expect(result.config.threshold).toBe(8);
    expect(result.config.dryRun).toBe(false);
    expect(result.config.label).toBe('ai-slop');
    expect(result.config.closeOnTrigger).toBe(true);
    expect(result.warnings.length).toBe(0);
  });

  it('falls back to defaults on malformed YAML', () => {
    const result = parseConfig('threshold: [\n');
    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('falls back to defaults for invalid values', () => {
    const raw = [
      'threshold: 100',
      'dry_run: "yes"',
      'label: ""',
      'close_on_trigger: "no"',
      'request_human_review: "no"',
      'human_override_token: ""',
      'response_template: ""'
    ].join('\n');

    const result = parseConfig(raw);

    expect(result.config.threshold).toBe(DEFAULT_CONFIG.threshold);
    expect(result.config.dryRun).toBe(DEFAULT_CONFIG.dryRun);
    expect(result.config.label).toBe(DEFAULT_CONFIG.label);
    expect(result.warnings.length).toBeGreaterThanOrEqual(7);
  });
});
