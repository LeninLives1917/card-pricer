// apps/server/server.js
// Owner: A1 | Slice: S5
//
// Thin bootstrap that imports the Express app and starts listening.
// NOT YET wired into package.json — root server.js stays the entrypoint
// until the phase-5 cutover (V2_RELEASE_NOTES). For now this exists so
// `node apps/server/server.js` works end-to-end as a pre-cutover smoke
// test for sub-agents, and `node --check` proves the whole graph imports.
//
// V1 boot banner preserved verbatim (server.js:5721-5729).

import app from './index.js';

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Card Pricer running at http://localhost:${PORT}`);
  console.log(`\n  API Status:`);
  console.log(`    Claude Vision:    ${process.env.ANTHROPIC_API_KEY ? 'configured' : 'MISSING — add ANTHROPIC_API_KEY to .env'}`);
  console.log(`    Cardmarket:       Direct links + API prices (Pokemon/MTG get EUR prices from API)`);
  console.log(`    Scryfall (MTG):   Free (includes EUR/Cardmarket prices)`);
  console.log(`    Pokemon TCG API:  Free (includes Cardmarket prices)`);
  console.log(`    eBay API:         ${process.env.EBAY_APP_ID ? 'configured' : 'not configured'}\n`);
  console.log('  Ready! No browser warmup needed — instant startup.\n');
});

// Graceful shutdown — preserved from V1 server.js:4399-4400.
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());
