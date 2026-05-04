// apps/server/routes/search.js
// Owner: A1 | Slice: S5
//
// GET /api/search — public Scryfall autocomplete + pokemontcg.io search.
// V1 server.js:5052-5101.

import express from 'express';
import { axios } from '../_clients.js';
import { getGameSlug } from '../_legacy-pricing.js';

const router = express.Router();

router.get('/api/search', async (req, res) => {
  try {
    const { q, game } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query required' });

    const results = [];

    if (game === 'magic' || !game) {
      try {
        const resp = await axios.get(`https://api.scryfall.com/cards/autocomplete`, {
          params: { q }, timeout: 5000
        });
        if (resp.data?.data) {
          results.push(...resp.data.data.map(name => ({ name, game: 'magic' })));
        }
      } catch (e) { /* skip */ }
    }

    if (game === 'pokemon' || !game) {
      try {
        const resp = await axios.get(`https://api.pokemontcg.io/v2/cards`, {
          params: { q: `name:"${q}*"`, pageSize: 10 }, timeout: 8000
        });
        if (resp.data?.data) {
          results.push(...resp.data.data.map(c => ({
            name: c.name,
            set: c.set?.name,
            set_code: c.set?.id,
            number: c.number,
            game: 'pokemon',
            image: c.images?.small
          })));
        }
      } catch (e) { /* skip */ }
    }

    if (game && !['magic', 'pokemon'].includes(game)) {
      const gameSlug = getGameSlug(game);
      const searchUrl = gameSlug
        ? `https://www.cardmarket.com/en/${gameSlug}/Products/Search?searchString=${encodeURIComponent(q)}`
        : `https://www.cardmarket.com/en/Search?searchString=${encodeURIComponent(q)}`;
      results.push({ name: q, game, cardmarket_url: searchUrl, type: 'cardmarket_link' });
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

export default router;
