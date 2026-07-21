import type { Assignments, EnvMap } from '../types/index.ts';

function upperSnake(input: string): string {
  return input
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

/**
 * Build the PORTLER_* environment variables that expose every assigned port,
 * URL, host, and Docker metadata to running services.
 */
export function buildGeneratedEnv(assignments: Assignments): EnvMap {
  const env: EnvMap = {};
  const serviceNames = Object.keys(assignments).sort();

  env.PORTLER_SERVICE_NAMES = serviceNames.join(',');

  for (const serviceName of serviceNames) {
    const assignment = assignments[serviceName]!;
    const prefix = `PORTLER_${upperSnake(serviceName)}`;

    env[`${prefix}_PORT`] = String(assignment.port);
    env[`${prefix}_URL`] = assignment.url;
    env[`${prefix}_HOST`] = assignment.host;
    env[`${prefix}_URL_HOST`] = assignment.urlHost;
    env[`${prefix}_PROTOCOL`] = assignment.protocol;

    if (assignment.desiredPort !== undefined) {
      env[`${prefix}_DESIRED_PORT`] = String(assignment.desiredPort);
    }

    if (assignment.containerName) {
      env[`${prefix}_CONTAINER`] = assignment.containerName;
    }

    if (assignment.image) {
      env[`${prefix}_IMAGE`] = assignment.image;
    }
  }

  return env;
}
