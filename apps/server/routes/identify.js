// apps/server/routes/identify.js
// Owner: A1 | Slice: S5
//
// Routes:
//   POST /api/identify                — identifyLimiter + requireAuth + enforceQuota + multer single
//   POST /api/identify-stream         — identifyLimiter + requireAuth + enforceQuota + multer single (NDJSON)
//   POST /api/identify-manual         — requireAuth + enforceQuota
//   POST /api/read-set-code           — identifyLimiter + requireAuth + enforceQuota
//   POST /api/lookup-by-number        — requireAuth + enforceQuota
//   POST /api/report-bad-id           — public (15MB body cap)
//   POST /api/correct-card            — requireAuth (V1 security fix in 1309ccd preserved)
//
// All handlers verbatim from V1 server.js with two changes:
//   1. Anthropic model strings replaced by READ_SET_CODE_MODEL constant
//      (V2_AUDIT §5.22 — refactor, not behaviour change).
//   2. Helpers moved to apps/server/_legacy-pricing.js + _card-db-boot.js
//      (S5 transient extraction; S6 absorbs them into pricing/).

import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { axios, anthropic, supabase } from '../_clients.js';
import { requireAuth } from '../middleware/auth.js';
import { enforceQuota, logScanEvent } from '../middleware/quota.js';
import { identifyLimiter } from '../middleware/rate-limit.js';
// S6 import-flip — these used to live in apps/server/_legacy-pricing.js;
// pricing/ now owns them. See V2_ARCHITECTURE §1 and S6 commit message.
import {
  identifyCore,
  doubleCheckAll,
  stripInternals,
  cacheSet,
  extractImageBuffer,
} from '../../../pricing/identify-core.js';
import { verifyIdentified } from '../../../pricing/verify.js';
import { resolveSetCode, PKM_SET_NAMES } from '../../../pricing/set-aliases.js';
import { POKEMONTCG_UNRELIABLE, REG_MARK_ERAS } from '../../../pricing/corrections.js';
import { READ_SET_CODE_MODEL } from '../../../pricing/confidence.js';
import { lookupTCGdex } from '../../../pricing/adapters/tcgdex.js';
import { lookupViaTCGGO } from '../../../pricing/adapters/tcggo-rapidapi.js';
import { lookupViaJustTCG } from '../../../pricing/adapters/justtcg.js';
import {
  CARD_DB,
  lookupLocalDb,
  cacheCardResult,
  saveCardDbToFile,
  markCardDbDirty,
} from '../_card-db-boot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

// Multer (in-memory, 20MB cap) — V1 server.js:872-876.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const router = express.Router();

// V1 server.js:1284-1312
router.post('/api/identify', identifyLimiter, requireAuth, enforceQuota, upload.single('image'), async (req, res) => {
  logScanEvent(req.user.id, '/api/identify');
  try {
    const buffer = extractImageBuffer(req);
    const hint = req.body.hint || '';

    const out = await identifyCore({ buffer, hint });
    if (out.cached) {
      console.log(`[IDENT-CACHE] HIT ${out.cacheKey.slice(0, 8)}`);
      return res.json(out.result);
    }

    if (out.parsed.cards?.length > 0) {
      console.log(`[VERIFY] Verifying ${out.parsed.cards.length} card(s) against databases...`);
      out.parsed.cards = await verifyIdentified(out.parsed.cards);
      out.parsed.cards = await doubleCheckAll(out.imageBase64, out.imageMediaType, out.parsed.cards);
    }

    const anyRejected = (out.parsed.cards || []).some(c => c?.verify_rejected);
    out.parsed.cards = stripInternals(out.parsed.cards);
    if (out.cacheKey && !anyRejected) cacheSet(out.cacheKey, out.parsed);
    res.json(out.parsed);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('Identification error:', err.message);
    res.status(500).json({ error: 'Failed to identify card', details: err.message });
  }
});

// V1 server.js:1326-1378
router.post('/api/identify-stream', identifyLimiter, requireAuth, enforceQuota, upload.single('image'), async (req, res) => {
  logScanEvent(req.user.id, '/api/identify-stream');
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch {} };

  try {
    let buffer;
    try { buffer = extractImageBuffer(req); }
    catch (e) { send({ type: 'error', error: e.message }); return res.end(); }

    const hint = req.body.hint || '';

    const out = await identifyCore({ buffer, hint });
    if (out.cached) {
      console.log(`[IDENT-STREAM-CACHE] HIT ${out.cacheKey.slice(0, 8)}`);
      send({ type: 'ident', cards: out.result.cards || [] });
      send({ type: 'verified', cards: out.result.cards || [] });
      send({ type: 'done' });
      return res.end();
    }

    send({ type: 'ident', cards: out.parsed.cards || [] });

    if (out.parsed.cards?.length > 0) {
      try {
        out.parsed.cards = await verifyIdentified(out.parsed.cards);
        out.parsed.cards = await doubleCheckAll(out.imageBase64, out.imageMediaType, out.parsed.cards);
      } catch (e) {
        console.error('[IDENT-STREAM] verify error:', e.message);
      }
    }
    out.parsed.cards = stripInternals(out.parsed.cards);
    send({ type: 'verified', cards: out.parsed.cards || [] });

    const anyRejected = (out.parsed.cards || []).some(c => c?.verify_rejected);
    if (out.cacheKey && !anyRejected) cacheSet(out.cacheKey, out.parsed);
    else if (anyRejected) console.log('[IDENT-STREAM-CACHE] SKIP — one or more cards had verify_rejected flag');
    send({ type: 'done' });
    res.end();
  } catch (err) {
    console.error('Identify-stream error:', err.message);
    send({ type: 'error', error: err.message });
    res.end();
  }
});

// V1 server.js:2447-2672 — /api/identify-manual.
router.post('/api/identify-manual', requireAuth, enforceQuota, async (req, res) => {
  logScanEvent(req.user.id, '/api/identify-manual');
  try {
    const { game, set_code, card_number, name } = req.body || {};
    if (!game) return res.status(400).json({ error: 'game is required' });
    if (!card_number) return res.status(400).json({ error: 'card_number is required' });

    const cleanNum = String(card_number).replace(/\/.*/, '').replace(/^0+/, '') || String(card_number);
    let card = null;

    if (game === 'pokemon') {
      const resolved = set_code ? resolveSetCode(set_code) : { setId: null, ptcgoCode: null };

      if (resolved.setId) {
        card = lookupLocalDb(resolved.setId, cleanNum);
        if (card) {
          console.log(`[MANUAL-PKM] Local DB hit: ${card.name} (${resolved.setId}-${cleanNum})`);
          return res.json({ cards: [card] });
        }
      }

      const queries = [];
      if (resolved.setId) {
        queries.push(`set.id:${resolved.setId} number:${cleanNum}`);
      }
      if (resolved.ptcgoCode && !resolved.aliased) {
        queries.push(`set.ptcgoCode:${resolved.ptcgoCode} number:${cleanNum}`);
      }
      if (set_code && !resolved.aliased && resolved.setId !== String(set_code).toLowerCase()) {
        queries.push(`set.id:${String(set_code).toLowerCase()} number:${cleanNum}`);
      }
      if (name) queries.push(`name:"${name}" number:${cleanNum}`);
      if (name) queries.push(`number:${cleanNum} name:"${name}"`);

      const skipPokemonTCG = resolved.setId && POKEMONTCG_UNRELIABLE.has(resolved.setId);
      if (skipPokemonTCG) {
        console.log(`[MANUAL-PKM] Skipping pokemontcg.io for unreliable set "${resolved.setId}" — going to fallbacks`);
      }

      if (resolved.setId && !skipPokemonTCG) {
        const directId = `${resolved.setId}-${cleanNum}`;
        console.log(`[MANUAL-PKM] Direct lookup: ${directId}`);
        try {
          const resp = await axios.get(`https://api.pokemontcg.io/v2/cards/${directId}`, { timeout: 10000 });
          const best = resp.data?.data;
          if (best) {
            card = {
              game: 'pokemon',
              name: best.name,
              set_name: best.set?.name,
              set_code: best.set?.id?.toUpperCase(),
              card_number: best.number,
              rarity: best.rarity,
              hp: best.hp,
              reference_image: best.images?.large || best.images?.small,
              cardmarket_url: best.cardmarket?.url || null,
              tcgplayer_url: best.tcgplayer?.url || null,
              verified: true,
              db_source: 'pokemontcg.io (manual)',
              _manual: true
            };
            console.log(`[MANUAL-PKM] Direct hit: ${best.name} (${directId})`);
          }
        } catch (e) {
          console.log(`[MANUAL-PKM] Direct lookup ${directId} failed: ${e.message}`);
        }
      }

      if (!card && !skipPokemonTCG) {
        for (const q of queries) {
          console.log(`[MANUAL-PKM] Trying: ${q}`);
          try {
            const resp = await axios.get('https://api.pokemontcg.io/v2/cards', {
              params: { q, pageSize: 10 }, timeout: 10000
            });
            const results = resp.data?.data;
            if (!results?.length) continue;
            let best = results[0];
            if (name) {
              const exact = results.find(d => d.name?.toLowerCase() === String(name).toLowerCase());
              if (exact) best = exact;
            }
            card = {
              game: 'pokemon',
              name: best.name,
              set_name: best.set?.name,
              set_code: best.set?.id?.toUpperCase(),
              card_number: best.number,
              rarity: best.rarity,
              hp: best.hp,
              reference_image: best.images?.large || best.images?.small,
              cardmarket_url: best.cardmarket?.url || null,
              tcgplayer_url: best.tcgplayer?.url || null,
              verified: true,
              db_source: 'pokemontcg.io (manual)',
              _manual: true
            };
            break;
          } catch (e) {
            console.error(`[MANUAL-PKM] Query failed: ${e.message}`);
          }
        }
      }

      if (!card && resolved.setId) {
        console.log(`[MANUAL-PKM] pokemontcg.io miss — trying fallback APIs for ${resolved.setId} #${cleanNum}`);

        const racers = [
          lookupTCGdex(resolved.setId, cleanNum),
          lookupViaJustTCG(resolved.setId, cleanNum)
        ];
        card = await Promise.race([
          ...racers.map(p => p.then(r => r || new Promise(() => {}))),
          Promise.allSettled(racers).then(rs => rs.find(s => s.status === 'fulfilled' && s.value)?.value || null)
        ]);

        if (!card) {
          card = await lookupViaTCGGO(resolved.setId, cleanNum, set_code);
        }

        if (card) {
          console.log(`[MANUAL-PKM] Fallback success: ${card.name} via ${card.db_source}`);
        } else {
          console.log(`[MANUAL-PKM] All fallbacks exhausted for ${set_code} #${cleanNum}`);
        }
      }
    } else if (game === 'magic') {
      const sc = set_code ? String(set_code).toLowerCase() : null;
      if (sc) {
        try {
          const url = `https://api.scryfall.com/cards/${sc}/${cleanNum}`;
          console.log(`[MANUAL-MTG] GET ${url}`);
          const resp = await axios.get(url, { timeout: 10000 });
          const d = resp.data;
          card = {
            game: 'magic',
            name: d.name,
            set_name: d.set_name,
            set_code: d.set?.toUpperCase(),
            card_number: d.collector_number,
            rarity: d.rarity,
            reference_image: d.image_uris?.normal || d.card_faces?.[0]?.image_uris?.normal,
            cardmarket_url: d.purchase_uris?.cardmarket || null,
            tcgplayer_url: d.purchase_uris?.tcgplayer || null,
            verified: true,
            db_source: 'scryfall.com (manual)',
            _manual: true
          };
        } catch (e) {
          console.error(`[MANUAL-MTG] Direct lookup failed: ${e.message}`);
        }
      }
      if (!card && name) {
        try {
          const resp = await axios.get('https://api.scryfall.com/cards/named', {
            params: { exact: name, set: sc || undefined }, timeout: 10000
          });
          const d = resp.data;
          card = {
            game: 'magic',
            name: d.name, set_name: d.set_name, set_code: d.set?.toUpperCase(),
            card_number: d.collector_number, rarity: d.rarity,
            reference_image: d.image_uris?.normal || d.card_faces?.[0]?.image_uris?.normal,
            cardmarket_url: d.purchase_uris?.cardmarket || null,
            tcgplayer_url: d.purchase_uris?.tcgplayer || null,
            verified: true, db_source: 'scryfall.com (manual)', _manual: true
          };
        } catch (e) { console.error(`[MANUAL-MTG] Named fallback failed: ${e.message}`); }
      }
    } else {
      card = {
        game,
        name: name || `${set_code || ''} #${card_number}`.trim(),
        set_name: set_code || null,
        set_code: set_code ? String(set_code).toUpperCase() : null,
        card_number: cleanNum,
        verified: false,
        _manual: true,
        db_source: 'manual entry (no DB lookup for ' + game + ')'
      };
    }

    if (!card) {
      return res.status(404).json({ error: 'No card found for that set/number combination. Double-check the set code and number.' });
    }

    if (card.game === 'pokemon' && set_code) {
      const resolved2 = resolveSetCode(set_code);
      if (resolved2.setId) {
        cacheCardResult(resolved2.setId, cleanNum, card);
      }
    }

    res.json({ cards: [card] });
  } catch (err) {
    console.error('[MANUAL] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// V1 server.js:2681-2830 — /api/read-set-code.
router.post('/api/read-set-code', identifyLimiter, requireAuth, enforceQuota, async (req, res) => {
  logScanEvent(req.user.id, '/api/read-set-code');
  try {
    const dataUrl = req.body?.image;
    if (!dataUrl) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const match = dataUrl.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid image data URL' });
    }

    const rawBuffer = Buffer.from(match[2], 'base64');
    let imageBase64, mediaType;
    if (rawBuffer.length > 4 * 1024 * 1024) {
      const resized = await sharp(rawBuffer)
        .resize({ width: 3200, withoutEnlargement: true })
        .jpeg({ quality: 98 })
        .toBuffer();
      imageBase64 = resized.toString('base64');
      mediaType = 'image/jpeg';
      console.log(`[READ-SET-CODE] Resized (too large): ${(rawBuffer.length/1024).toFixed(0)}KB → ${(resized.length/1024).toFixed(0)}KB`);
    } else {
      imageBase64 = match[2];
      mediaType = match[1];
      console.log(`[READ-SET-CODE] Passthrough: ${(rawBuffer.length/1024).toFixed(0)}KB (${mediaType})`);
    }

    console.log('[READ-SET-CODE] Sending to Claude Sonnet 4.6...');
    const t0 = Date.now();

    const response = await anthropic.messages.create({
      model: READ_SET_CODE_MODEL,
      max_tokens: 20,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: imageBase64 }
          },
          {
            type: 'text',
            text: `Read the set code and card number printed on this Pokemon card. Look near the bottom of the card for small text.

CRITICAL — PRESERVE LEADING ZEROS. If the printed number is "027", report "027". NOT "27" and NOT "2". Dropping zeros sends this card to the wrong entry in our database and returns a completely different card. "003/165" is NOT "3/165". This is the #1 failure mode — treat every digit you see as load-bearing, including leading zeros.

FORMATS to look for (check all):

1. MODERN (most common): [reg mark] [SET CODE] [LANG] [NUMBER]
   The set code is 2-4 uppercase letters, often in a small box. Examples:
   MEP EN 066 → return "MEP 066"
   DRI EN 204/182 → return "DRI 204/182"
   SVP EN 153 → return "SVP 153"
   WHT EN 131/086 → return "WHT 131/086"

2. SWSH PROMOS: SWSH followed by 3 digits, e.g. SWSH020, SWSH066
   Return as-is: "SWSH020"

3. GALARIAN GALLERY: GG + number / GG + number, e.g. GG31/GG70
   Return as-is: "GG31/GG70"

4. OLDER CARDS: Just a regulation mark (D, E, F) + number, no set code box.
   Return: "NONE"

VALID SET CODES (read the letters VERY carefully — M vs W, E vs F, G vs C matter):
SVI, PAL, OBF, MEW, PAR, PAF, TEF, TWM, SFA, SCR, SSP, PRE, JTG, DRI,
MEG, PFL, POR, SVP, MEP, WHT, BBT, ASH, DIA,
SSH, RCL, DAA, CPA, VIV, BST, CRE, EVS, FST, BRS, ASR, LOR, SIT, CRZ, SWP

SET TOTAL HINTS (use the number after "/" to verify you read the set code correctly):
MEG = /132, PFL = /094, POR = /088, MEP has no total, WHT = /086, BBT = /086,
DRI = /182, SSP = /191, SVI = /198, MEW = /165, SVP has no total, DIA = /182
If the total doesn't match the set code, re-read the set code letters more carefully.

Return ONLY the set code and number. If you cannot read any set code, respond: NONE`
          }
        ]
      }]
    });

    let raw = (response.content?.[0]?.text || '').trim();
    const elapsed = Date.now() - t0;
    console.log(`[READ-SET-CODE] ${elapsed}ms → raw "${raw}"`);

    raw = raw.replace(/\*\*/g, '').replace(/^#+\s*/, '');
    if (raw.length > 30) {
      const codeMatch = raw.match(/\b([A-Z]{2,5})\s+(?:EN\s+)?(\d{1,4}(?:\s*\/\s*\d{1,4})?)\b/)
        || raw.match(/\bSWSH\d{3,4}\b/)
        || raw.match(/\bGG\d{1,3}\s*\/\s*GG\d{1,3}\b/);
      if (codeMatch) {
        raw = codeMatch[0].replace(/\s*EN\s+/, ' ');
        console.log(`[READ-SET-CODE] Extracted from verbose: "${raw}"`);
      } else {
        raw = 'NONE';
      }
    }
    raw = raw.replace(/^([A-Z]{2,4})(EN)\s/, '$1 ');

    const SET_TOTALS = {
      'MEG':'132','PFL':'094','POR':'088','WHT':'086','BBT':'086',
      'DRI':'182','SSP':'191','SVI':'198','MEW':'165','DIA':'182',
      'PAL':'198','OBF':'197','PAR':'182','PAF':'091','TEF':'162',
      'TWM':'167','SFA':'064','SCR':'156','PRE':'175','JTG':'182',
      'SSH':'202','RCL':'192','DAA':'189','VIV':'185','BST':'163',
      'CRE':'198','EVS':'203','FST':'264','BRS':'172','ASR':'189',
      'LOR':'196','SIT':'195','CRZ':'230',
    };
    const totalMatch = raw.match(/^([A-Z]{2,4})\s+(\d+)\s*\/\s*(\d+)$/);
    if (totalMatch) {
      const [, readCode, cardNum, total] = totalMatch;
      const expectedTotal = SET_TOTALS[readCode];
      if (expectedTotal && expectedTotal !== total) {
        const correctCode = Object.entries(SET_TOTALS).find(([, t]) => t === total)?.[0];
        if (correctCode) {
          const corrected = `${correctCode} ${cardNum}/${total}`;
          console.log(`[READ-SET-CODE] CORRECTED: "${raw}" → "${corrected}" (total /${total} matches ${correctCode}, not ${readCode})`);
          raw = corrected;
        }
      }
    }

    console.log(`[READ-SET-CODE] ${elapsed}ms → final "${raw}"`);

    if (!raw || raw === 'NONE') {
      return res.status(404).json({ error: 'Could not read set code from image' });
    }

    res.json({ text: raw });
  } catch (err) {
    console.error('[READ-SET-CODE] Error:', err.message, err.status || '', err.error?.message || '');
    res.status(500).json({ error: err.message });
  }
});

// V1 server.js:2920-3052 — /api/lookup-by-number.
router.post('/api/lookup-by-number', requireAuth, enforceQuota, express.json(), async (req, res) => {
  logScanEvent(req.user.id, '/api/lookup-by-number');
  try {
    const { number, set_code: setCode, game, reg_mark } = req.body || {};
    if (!number || typeof number !== 'string') {
      return res.status(400).json({ error: 'number required' });
    }

    const raw = number.trim();

    if (setCode && (game === 'magic' || !game)) {
      const numOnly = raw.split('/')[0].replace(/^0+/, '') || raw;
      try {
        const resp = await axios.get(
          `https://api.scryfall.com/cards/${encodeURIComponent(setCode.toLowerCase())}/${encodeURIComponent(numOnly)}`,
          { timeout: 6000 }
        );
        const d = resp.data;
        if (d && d.name) {
          const card = {
            game: 'magic',
            name: d.name,
            set_name: d.set_name,
            set_code: (d.set || '').toUpperCase(),
            card_number: d.collector_number,
            rarity: d.rarity,
            image_url: d.image_uris?.normal || d.image_uris?.large,
            cardmarket_url: d.purchase_uris?.cardmarket || null,
            tcgplayer_url: d.purchase_uris?.tcgplayer || null,
            source: 'scryfall.com (ocr-direct)'
          };
          console.log(`[OCR-LOOKUP] Scryfall HIT: ${card.name} ${card.set_code} #${card.card_number}`);
          return res.json({ cards: [card] });
        }
      } catch (e) {
        console.log(`[OCR-LOOKUP] Scryfall miss: ${e.message}`);
      }
    }

    const hasSlash = raw.includes('/');
    let numPart, totalPart;
    if (hasSlash) {
      const [a, b] = raw.split('/');
      numPart = (a || '').replace(/^0+/, '') || a;
      totalPart = (b || '').replace(/^0+/, '') || b;
    } else {
      numPart = raw;
    }

    if (game !== 'magic') {
      const queries = [];
      if (hasSlash && numPart && totalPart) {
        queries.push(`number:"${numPart}" set.printedTotal:${totalPart}`);
        queries.push(`number:"${numPart}" set.total:${totalPart}`);
      } else if (numPart) {
        queries.push(`number:"${numPart}"`);
      }

      for (const q of queries) {
        try {
          const resp = await axios.get('https://api.pokemontcg.io/v2/cards', {
            params: { q, pageSize: 10 },
            timeout: 6000
          });
          const results = resp.data?.data || [];
          if (results.length === 1) {
            const d = results[0];
            const card = {
              game: 'pokemon',
              name: d.name,
              set_name: d.set?.name,
              set_code: (d.set?.id || '').toUpperCase(),
              card_number: d.number,
              rarity: d.rarity,
              hp: d.hp,
              image_url: d.images?.large || d.images?.small,
              cardmarket_url: d.cardmarket?.url || null,
              tcgplayer_url: d.tcgplayer?.url,
              source: 'pokemontcg.io (ocr-direct)'
            };
            console.log(`[OCR-LOOKUP] PokemonTCG HIT: ${card.name} ${card.set_code} #${card.card_number}`);
            return res.json({ cards: [card] });
          } else if (results.length > 1 && reg_mark) {
            const era = REG_MARK_ERAS[reg_mark];
            if (era) {
              console.log(`[OCR-LOOKUP] Ambiguous: ${results.length} matches for ${q}, using reg mark ${reg_mark} to filter (${era.prefix} era)`);
              const filtered = results.filter(d => {
                const setId = (d.set?.id || '').toLowerCase();
                const releaseYear = d.set?.releaseDate ? parseInt(d.set.releaseDate.substring(0, 4)) : 0;
                const eraMatch = era.prefix ? setId.startsWith(era.prefix) : true;
                const yearMatch = releaseYear >= era.minYear && releaseYear <= era.maxYear;
                return eraMatch || yearMatch;
              });
              if (filtered.length === 1) {
                const d = filtered[0];
                const card = {
                  game: 'pokemon',
                  name: d.name,
                  set_name: d.set?.name,
                  set_code: (d.set?.id || '').toUpperCase(),
                  card_number: d.number,
                  rarity: d.rarity,
                  hp: d.hp,
                  image_url: d.images?.large || d.images?.small,
                  cardmarket_url: d.cardmarket?.url || null,
                  tcgplayer_url: d.tcgplayer?.url,
                  source: `pokemontcg.io (ocr-direct, reg:${reg_mark})`
                };
                console.log(`[OCR-LOOKUP] Reg-mark filtered HIT: ${card.name} ${card.set_code} #${card.card_number}`);
                return res.json({ cards: [card] });
              } else {
                console.log(`[OCR-LOOKUP] Reg-mark filter left ${filtered.length} matches (from ${results.length})`);
              }
            }
          } else if (results.length > 1) {
            console.log(`[OCR-LOOKUP] Ambiguous: ${results.length} matches for ${q}`);
          }
        } catch (e) {
          console.log(`[OCR-LOOKUP] PokemonTCG error: ${e.message}`);
        }
      }
    }

    return res.status(404).json({ error: 'no unique match' });
  } catch (err) {
    console.error('[OCR-LOOKUP] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// V1 server.js:2838-2862 — /api/report-bad-id (15MB body cap).
router.post('/api/report-bad-id', express.json({ limit: '15mb' }), async (req, res) => {
  try {
    const { card, reason, image, timestamp, ua } = req.body || {};
    const logDir = join(REPO_ROOT, 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const entry = {
      t: new Date().toISOString(),
      reason: (reason || '').slice(0, 500),
      card: card ? {
        name: card.name, game: card.game, set_name: card.set_name,
        set_code: card.set_code, card_number: card.card_number,
        rarity: card.rarity, variant: card.variant
      } : null,
      had_image: !!image,
      ua: (ua || '').slice(0, 200),
      orig_timestamp: timestamp
    };
    fs.appendFileSync(join(logDir, 'bad-ids.log'), JSON.stringify(entry) + '\n');
    console.log(`[BAD-ID] ${entry.card?.name || '?'} — ${entry.reason || '(no reason)'}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[BAD-ID] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// V1 server.js:2874-2908 — /api/correct-card (V1 security fix preserved:
// requireAuth gate + user_id audit log).
router.post('/api/correct-card', requireAuth, express.json(), (req, res) => {
  try {
    const { set_code, card_number, correct_name } = req.body || {};
    if (!set_code || !card_number || !correct_name) {
      return res.status(400).json({ error: 'set_code, card_number, and correct_name required' });
    }

    const resolved = resolveSetCode(set_code);
    const setId = resolved.setId || set_code.toLowerCase();
    const cleanNum = String(card_number).replace(/\/.*/, '').replace(/^0+/, '') || String(card_number);

    const key = `${setId}-${cleanNum}`;
    const existing = CARD_DB.get(key) || {};

    CARD_DB.set(key, {
      ...existing,
      name: correct_name.trim(),
      setName: existing.setName || PKM_SET_NAMES[setId] || set_code,
      setCode: (existing.setCode || set_code).toUpperCase(),
      source: 'manual',
    });

    markCardDbDirty();
    saveCardDbToFile();

    console.log(`[CORRECT] ${key}: "${existing.name || '?'}" → "${correct_name.trim()}" (manual override by ${req.user?.id || 'unknown'})`);
    res.json({ ok: true, key, oldName: existing.name || null, newName: correct_name.trim() });
  } catch (err) {
    console.error('[CORRECT] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
