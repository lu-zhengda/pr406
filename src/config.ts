import { load } from 'js-yaml';

import { DEFAULT_CONFIG, DEFAULT_RESPONSE_TEMPLATE } from './constants';
import type { GitHubApi, LoadConfigResult, Pr406Config } from './types';

interface LoadConfigArgs {
  github: GitHubApi;
  owner: string;
  repo: string;
  configPath: string;
  ref?: string;
}

function validateThreshold(value: unknown, warnings: string[]): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    warnings.push('Invalid threshold in config; using default 7.');
    return DEFAULT_CONFIG.threshold;
  }

  const rounded = Math.floor(value);
  if (rounded < 1 || rounded > 20) {
    warnings.push('Config threshold must be between 1 and 20; using default 7.');
    return DEFAULT_CONFIG.threshold;
  }

  return rounded;
}

function validateBoolean(value: unknown, fieldName: string, defaultValue: boolean, warnings: string[]): boolean {
  if (typeof value !== 'boolean') {
    warnings.push(`Invalid ${fieldName} in config; using default ${String(defaultValue)}.`);
    return defaultValue;
  }
  return value;
}

function validateString(
  value: unknown,
  fieldName: string,
  defaultValue: string,
  warnings: string[],
  minLength = 1
): string {
  if (typeof value !== 'string' || value.trim().length < minLength) {
    warnings.push(`Invalid ${fieldName} in config; using default.`);
    return defaultValue;
  }
  return value.trim();
}

export function parseConfig(rawContent: string): LoadConfigResult {
  const warnings: string[] = [];
  let parsed: unknown;

  try {
    parsed = load(rawContent);
  } catch {
    return {
      config: { ...DEFAULT_CONFIG },
      warnings: ['Failed to parse config YAML; using defaults.']
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      config: { ...DEFAULT_CONFIG },
      warnings: ['Config root is not a YAML object; using defaults.']
    };
  }

  const input = parsed as Record<string, unknown>;

  const config: Pr406Config = {
    threshold: validateThreshold(input.threshold, warnings),
    dryRun: validateBoolean(input.dry_run, 'dry_run', DEFAULT_CONFIG.dryRun, warnings),
    label: validateString(input.label, 'label', DEFAULT_CONFIG.label, warnings),
    closeOnTrigger: validateBoolean(
      input.close_on_trigger,
      'close_on_trigger',
      DEFAULT_CONFIG.closeOnTrigger,
      warnings
    ),
    requestHumanReview: validateBoolean(
      input.request_human_review,
      'request_human_review',
      DEFAULT_CONFIG.requestHumanReview,
      warnings
    ),
    humanOverrideToken: validateString(
      input.human_override_token,
      'human_override_token',
      DEFAULT_CONFIG.humanOverrideToken,
      warnings
    ),
    responseTemplate: validateString(
      input.response_template,
      'response_template',
      DEFAULT_RESPONSE_TEMPLATE,
      warnings,
      5
    )
  };

  return {
    config,
    warnings
  };
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const maybeStatus = (error as Record<string, unknown>).status;
  return maybeStatus === 404;
}

export async function loadConfigFromRepo(args: LoadConfigArgs): Promise<LoadConfigResult> {
  const { github, owner, repo, configPath, ref } = args;

  try {
    const response = await github.rest.repos.getContent({
      owner,
      repo,
      path: configPath,
      ref
    });

    const data = response.data;

    if (Array.isArray(data)) {
      return {
        config: { ...DEFAULT_CONFIG },
        warnings: [`Config path ${configPath} is a directory; using defaults.`]
      };
    }

    if (data.type !== 'file' || typeof data.content !== 'string') {
      return {
        config: { ...DEFAULT_CONFIG },
        warnings: [`Config path ${configPath} is not a regular file; using defaults.`]
      };
    }

    const decoded = Buffer.from(data.content, 'base64').toString('utf8');
    return parseConfig(decoded);
  } catch (error) {
    if (isNotFound(error)) {
      return {
        config: { ...DEFAULT_CONFIG },
        warnings: [`Config file ${configPath} not found; using defaults.`]
      };
    }

    return {
      config: { ...DEFAULT_CONFIG },
      warnings: [`Failed to load config from ${configPath}; using defaults.`]
    };
  }
}
