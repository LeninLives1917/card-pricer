// apps/server/routes/card-db.js
// Owner: A1 | Slice: S5
//
// Routes:
//   GET  /api/card-db-status                — public
//   GET  /api/card-db-export                — public; CSV dump of CARD_DB
//   POST /api/card-db-rebuild               — requireAuth + requireAdmin (V1 1309ccd security fix preserved)
//   POST /api/card-db-import-unreliable     — requireAuth + requireAdmin (V1 1309ccd security fix preserved)
//
// V1 server.js:1989-1996, 2087-2098, 2104-2110, 2213-2217.

import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  CARD_DB,
  isCardDbLoading,
  getCardDbState,
  clearCardDbForRebuild,
  resetUnreliableImportFlag,
  downloadCardDatabase,
  importUnreliableSetsFromTCGGO,
} from '../_card-db-boot.js';
import { POKEMONTCG_UNRELIABLE, PKM_SET_NAMES } from '../_legacy-pricing.js';

const router = express.Router();

router.get('/api/card-db-status', (req, res) => {
  res.json(getCardDbState());
});

router.get('/api/card-db-export', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="card-db.csv"');

  let csv = 'set_id,number,name,set_name,set_code,rarity,hp\n';
  for (const [key, val] of CARD_DB) {
    const esc = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
    const [setId, num] = key.split('-');
    csv += `${esc(setId)},${esc(num)},${esc(val.name)},${esc(val.setName)},${esc(val.setCode)},${esc(val.rarity)},${esc(val.hp)}\n`;
  }
  res.send(csv);
});

router.post('/api/card-db-rebuild', requireAuth, requireAdmin, (req, res) => {
  if (isCardDbLoading()) return res.json({ status: 'already loading', count: CARD_DB.size });
  clearCardDbForRebuild();
  downloadCardDatabase();
  res.json({ status: 'rebuild started' });
});

router.post('/api/card-db-import-unreliable', requireAuth, requireAdmin, (req, res) => {
  resetUnreliableImportFlag();
  importUnreliableSetsFromTCGGO();
  res.json({ status: 'import started', sets: [...POKEMONTCG_UNRELIABLE].filter(s => PKM_SET_NAMES[s]) });
});

export default router;
