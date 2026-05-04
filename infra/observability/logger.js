// infra/observability/logger.js
// Owner: A8 | Slice: S4 (skeleton) → S14 (wired by A1 in server bootstrap)
//
// Pino-based structured logger factory.
// - JSON output in prod (NODE_ENV=production) — Render captures stdout JSON
//   line-by-line and Sentry's logger integration ingests it.
// - Pretty output in dev — pino-pretty for human-readable terminal logs.
// - Default level INFO; override via LOG_LEVEL env (trace|debug|info|warn|error|fatal).
//
// USAGE:
//     import getLogger from '../infra/observability/logger.js';
//     const log = getLogger('routes/identify');
//     log.info({ user_id, scan_id }, 'identify start');
//     log.error({ err }, 'identify failed');
//
// The `name` binding shows up as the `name` field on every line, which
// makes Render-log filtering by module straightforward.
//
// NOTE FOR S5 OWNER (A1): pino + pino-pretty are NOT yet declared in
// package.json. Add them as dependencies when wiring this into the
// server bootstrap:
//     npm install pino pino-pretty
// Until then, importing this module will throw at module-load time.

import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || 'info';

// Single root logger; child loggers per module via `getLogger(name)` so
// every line carries `{ name: 'routes/identify', ... }` for filtering.
const rootLogger = pino({
  level,
  // Standard, predictable timestamps for log aggregation.
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redact common accidental-secret leaks at the logger level. The
  // Sentry beforeSend (sentry-server.js) handles event payloads
  // separately; this protects pino lines specifically.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.token',
      '*.api_key',
      '*.apiKey',
      '*.secret',
    ],
    censor: '[REDACTED]',
  },
  // Pretty-print only in dev. In prod, write line-delimited JSON so
  // Render's log shipper + Sentry both ingest cleanly.
  transport: isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
  base: {
    // Surface the deployed git SHA on every log line so a "which build
    // emitted this?" investigation is one filter away.
    git_sha: process.env.GIT_SHA || 'unknown',
    env: process.env.SENTRY_ENVIRONMENT || (isProd ? 'production' : 'development'),
  },
});

/**
 * @param {string} name  Module identifier; appears as `name` in every line.
 * @returns {import('pino').Logger}
 */
export default function getLogger(name) {
  if (!name || typeof name !== 'string') {
    throw new TypeError('getLogger(name) requires a non-empty string');
  }
  return rootLogger.child({ name });
}

// Also expose the root logger for the express bootstrap that needs to
// install pino-http or similar at the app level rather than per-module.
export { rootLogger };
