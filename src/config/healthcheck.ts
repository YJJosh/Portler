import { DEFAULT_HEALTHCHECK_INTERVAL_MS, DEFAULT_HEALTHCHECK_TIMEOUT_MS } from '../constants.ts';
import { isObject, optionalPositiveDuration, optionalString } from './scalars.ts';
import type { HealthcheckConfig, HealthcheckType, UnknownMap } from '../types/index.ts';

function inferHealthcheckType(value: UnknownMap): HealthcheckType {
  if (value.command !== undefined || value.test !== undefined) return 'command';
  if (value.url !== undefined) return 'http';
  return 'tcp';
}

function normalizeHealthcheckType(value: string, name: string): HealthcheckType {
  if (value === 'none' || value === 'tcp' || value === 'http' || value === 'command') return value;
  throw new Error(`${name} must be one of: none, tcp, http, command`);
}

export function normalizeHealthcheck(value: unknown, serviceName: string): HealthcheckConfig | undefined {
  if (value === undefined || value === null) return undefined;

  if (value === 'none' || value === false) {
    return {
      type: 'none',
      timeoutMs: DEFAULT_HEALTHCHECK_TIMEOUT_MS,
      intervalMs: DEFAULT_HEALTHCHECK_INTERVAL_MS,
    };
  }

  if (typeof value === 'string') {
    return {
      type: normalizeHealthcheckType(value, `services.${serviceName}.healthcheck`),
      timeoutMs: DEFAULT_HEALTHCHECK_TIMEOUT_MS,
      intervalMs: DEFAULT_HEALTHCHECK_INTERVAL_MS,
    };
  }

  if (!isObject(value)) throw new Error(`services.${serviceName}.healthcheck must be a string or object`);

  const type = normalizeHealthcheckType(optionalString(value.type, `services.${serviceName}.healthcheck.type`) ?? inferHealthcheckType(value), `services.${serviceName}.healthcheck.type`);

  return {
    type,
    command: optionalString(value.command ?? value.test, `services.${serviceName}.healthcheck.command`),
    url: optionalString(value.url, `services.${serviceName}.healthcheck.url`),
    // Both must be > 0: a zero/negative timeout makes the service fail its
    // readiness check the instant it starts, and a zero interval turns the
    // readiness poll into a busy-loop that pins a CPU core.
    timeoutMs:
      optionalPositiveDuration(value.timeout_ms, `services.${serviceName}.healthcheck.timeout_ms`) ??
      optionalPositiveDuration(value.timeoutMs, `services.${serviceName}.healthcheck.timeoutMs`) ??
      DEFAULT_HEALTHCHECK_TIMEOUT_MS,
    intervalMs:
      optionalPositiveDuration(value.interval_ms, `services.${serviceName}.healthcheck.interval_ms`) ??
      optionalPositiveDuration(value.intervalMs, `services.${serviceName}.healthcheck.intervalMs`) ??
      DEFAULT_HEALTHCHECK_INTERVAL_MS,
  };
}
