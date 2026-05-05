// infra/observability/logger.js
// Owner: A8 | Slice: S14 (final)
//
// Pino-based structured logger factory.
// - JSON output in prod (NODE_ENV=production) — Render captures stdout JSON
//   line-by-line.
// - Pretty output in dev — pino-pretty for human-readable terminal logs.
// - Default level INFO; override via LOG_LEVEL env (trace|debug|info|warn|error|fatal).
//
// USAGE:
//     import getLogger from '../infra/observability/logger.js';
//     const log = getLogger('routes/identify');
//     log.info({ user_id, scan_id }, 'identify start');
//     log.error({ err }, 'identify failed');
//
// The `component` binding shows up on every line, which makes
// Render-log filtering by module straightforward.

import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || 'info';

// Build options. We do NOT enable pino-pretty's transport in tests
// (Node test runner runs in worker threads where transport workers can
// race the process exit). Plain JSON to stdout is fine there.
const wantPretty = !isProd && process.env.NODE_ENV !== 'test';

let rootLogger;
try {
  rootLogger = pino({
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    // Redact common accidental-secret leaks at the logger level. The
    // Sentry beforeSend (sentry-server.js) handles event payloads
    // separately; this protects pino lines specifically.
    redact: {
      paths: [
        'authorization',
        'cookie',
        'req.headers.authorization',
        'req.headers.cookie',
        '*.cardImage',
        '*.image',
        'body.image',
        'body.cards.*.photo',
        '*.password',
        '*.token',
        '*.api_key',
        '*.apiKey',
        '*.secret',
      ],
      censor: '[REDACTED]',
    },
    transport: wantPretty
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
    base: {
      git_sha: process.env.GIT_SHA || 'unknown',
      env: process.env.SENTRY_ENVIRONMENT || (isProd ? 'production' : 'development'),
    },
  });
} catch (e) {
  // Defensive: only triggered if NODE_ENV is unset AND pino itself failed
  // to construct (unusable runtime). Per S14 brief, fall through to console
  // ONLY in that case.
  if (!process.env.NODE_ENV) {
    console.warn('[logger] pino init failed; falling back to console:', e?.message);
    rootLogger = makeConsoleShim();
  } else {
    throw e;
  }
}

function makeConsoleShim() {
  const shim = {
    level,
    info:  (...a) => console.log('[info]', ...a),
    warn:  (...a) => console.warn('[warn]', ...a),
    error: (...a) => console.error('[error]', ...a),
    debug: (...a) => console.debug('[debug]', ...a),
    trace: () => {},
    fatal: (...a) => console.error('[fatal]', ...a),
    child: () => shim,
  };
  return shim;
}

/**
 * @param {string} name  Module identifier; appears as `component` in every line.
 * @returns {import('pino').Logger}
 */
function getLogger(name) {
  if (!name || typeof name !== 'string') {
    throw new TypeError('getLogger(name) requires a non-empty string');
  }
  return rootLogger.child({ component: name });
}

export default getLogger;
export { getLogger, rootLogger };
