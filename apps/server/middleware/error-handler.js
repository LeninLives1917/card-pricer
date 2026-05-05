// apps/server/middleware/error-handler.js
// Owner: A1 | Slice: S5
//
// V1 server.js relied on Express's built-in default error handler — every
// route handler is async and catches its own errors with try/catch +
// res.status(...).json(...). For S5 we KEEP that contract: route handlers
// own their error responses; this module exists as a final safety net for
// anything that escapes.
//
// CONTRACT:
//   - Route handlers MUST continue to use try/catch + res.status(...).json(...)
//     for expected failures. The error sink below is for unexpected throws
//     (programmer bugs, sync errors in middleware, etc.).
//   - In production we never leak stack traces to the client (V2_ARCHITECTURE
//     §2.9 — 500 = "server error").
//   - S14 (A8 observability) replaces this with Sentry-aware error reporting.
//     Until then, console.error is fine.
//
// Wiring: app.use(errorHandler) AFTER all routes are mounted. Any handler
// that calls next(err) — or throws synchronously inside a sync handler —
// lands here.

export function errorHandler(err, req, res, next) {
  // If headers already went out (e.g. mid-stream NDJSON), let Express close.
  if (res.headersSent) return next(err);

  const status = err?.status || err?.statusCode || 500;
  console.error(`[ERR] ${req.method} ${req.originalUrl} → ${status} ${err?.message || 'unknown'}`);
  if (err?.stack && process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }

  res.status(status).json({
    error: err?.message || 'server error',
    // 4xx errors are allowed to surface details; 5xx stay opaque to clients.
    ...(status < 500 && err?.details ? { details: err.details } : {}),
  });
}
