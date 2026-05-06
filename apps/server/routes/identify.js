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
import { identifyLimiter, quoteLeadLimiter } from '../middleware/rate-limit.js';
// S15 (OCR-first): pipeline + collaborators. Only the route handler at
// /api/v2/identify-ocr-first reaches into these — the rest of the file is
// V1-shape preserved.
import { runOcrFirst } from '../../../pricing/ocr-first/pipeline.js';
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
import { detectBinderCards } from '../../../pricing/binder.js';
import { detectBinderCardsCV } from '../../../pricing/binder-cv.js';
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

// =============================================================================
// /api/identify-binder — single binder-page photo → up to 12 cropped, identified
// cards. NEW in V2. See pricing/binder.js for the bbox-detection helper.
//
// Flow:
//   1. Multer drops the raw image into req.file.buffer.
//   2. detectBinderCards(buffer) → Sonnet 4.6 returns normalised bboxes.
//   3. sharp.metadata() gives us pixel dimensions for the crop maths.
//   4. Each bbox is cropped via sharp.extract() in parallel.
//   5. Each crop runs through identifyCore + verify in parallel — full
//      single-card pipeline per pocket. With 12 cards that's ~24-30
//      simultaneous Sonnet calls during the verify burst, which is the
//      practical ceiling on the paid tier (RPM ~50, TPM ~80k). If we ever
//      add multi-page binder scanning, drop to chunks of ~8.
//   6. Response shape matches /api/identify: { cards: [...] } so the
//      vendor session-tab handles binder results identically to single
//      scans.
//
// Quota: one binder request = one logScanEvent + one enforceQuota tick.
// We deliberately do NOT charge per-card here; it's one operator action.
// =============================================================================

// Detect a "Basic <type> Energy" name. These are the most common false
// positive in multi-card crops because basic-energy art is just a
// uniform colored background with a small element symbol — anything
// vaguely matching that pattern (a holo's coloured splash, a uniform
// patch of card art) gets identified as one. Real basic energies do
// exist as binder entries, but when they appear ALONGSIDE a non-energy
// card from the same crop, the energy is the phantom.
const BASIC_ENERGY_RE = /^\s*basic\s+(grass|fire|water|lightning|psychic|fighting|darkness|metal|fairy|dragon|colorless|colourless)\s+energy\s*$/i;

function isBasicEnergyName(name) {
  return BASIC_ENERGY_RE.test(name || '');
}

/**
 * Choose which card to keep when identifyCore returned multiple from a
 * single binder crop.
 *
 * Rule:
 *   - If the candidates include ≥1 non-basic-energy card, return the
 *     first non-basic-energy. The basic energies are the phantoms.
 *   - Otherwise (all candidates are basic energies, or just one card
 *     came back), return the first.
 *
 * Caller is expected to have already filtered out unnamed / verify-
 * rejected cards.
 */
function pickPrimaryCard(namedCards) {
  if (namedCards.length === 1) return namedCards[0];
  const nonEnergy = namedCards.find((c) => !isBasicEnergyName(c.name));
  return nonEnergy || namedCards[0];
}

router.post('/api/identify-binder',
  identifyLimiter,
  requireAuth,
  enforceQuota,
  upload.single('image'),
  async (req, res) => {
    logScanEvent(req.user.id, '/api/identify-binder');
    const t0 = Date.now();
    try {
      const buffer = extractImageBuffer(req);
      const mediaType = req.file?.mimetype || 'image/jpeg';

      const meta = await sharp(buffer).metadata();
      const W = meta.width || 0;
      const H = meta.height || 0;
      if (!W || !H) {
        return res.status(400).json({ error: 'Could not read image dimensions' });
      }

      // Two detectors, used in cascade:
      //   1. CV grid detection (pricing/binder-cv.js) — ~100ms, free,
      //      deterministic, pixel-precise. Works on cleanly-photographed
      //      pages with visible inter-pocket gaps. The common case.
      //   2. Sonnet bbox detection (pricing/binder.js) — ~3s, costs an
      //      Anthropic call, handles the awkward cases CV can't (heavy
      //      perspective, edge-to-edge cards, single-card photos).
      // CV runs first; if it returns < 2 cards we fall back to Claude.
      // The threshold is intentional: CV returning 0 or 1 means it
      // couldn't find a grid at all, not that the page only has one
      // card — those genuinely-sparse pages would be handled fine by
      // Claude and we'd rather not mis-call them.
      let detection;
      let detectionPath = 'cv';
      const cvOut = await detectBinderCardsCV({ buffer });
      console.log(`[BINDER] CV detect: ${cvOut.cards.length} bbox(es) in ${cvOut.ms}ms (${cvOut.reason})`);
      if (cvOut.cards.length >= 2) {
        detection = cvOut;
      } else {
        console.log('[BINDER] CV insufficient — falling back to Claude bbox detection');
        const claudeT0 = Date.now();
        detection = await detectBinderCards({ buffer, mediaType });
        detectionPath = 'claude';
        console.log(`[BINDER] Claude detect: ${detection.cards?.length || 0} bbox(es) in ${Date.now() - claudeT0}ms`);
      }
      const bboxes = detection.cards || [];
      if (!bboxes.length) {
        return res.json({
          cards: [],
          binder: { count: 0, identified: 0, image_w: W, image_h: H, detection_path: detectionPath },
        });
      }

      // Crop each bbox in parallel, with a small outward pad so that crops
      // where Sonnet bound the box a hair INTO the card still capture the
      // top name banner / bottom set-code stripe. 2% pad on each side
      // (clamped to image bounds) — half of the original 4% after we
      // observed off-centre bboxes growing into adjacent pockets at 4%.
      // Smaller pad means a misaligned bbox stays misaligned (rather than
      // smearing into the next card and corrupting identifyCore).
      const PAD = 0.02;
      // Trading-card aspect ratio is ~5:7 (w/h ≈ 0.71). Logging w/h on
      // every bbox makes it obvious when Sonnet returns garbage shapes
      // (e.g. 1.4 = double-width, 0.3 = sliver) — those are the rows
      // most likely to mis-identify, so worth surfacing in logs.
      const crops = await Promise.all(bboxes.map(async (bb, i) => {
        const padX = bb.w * PAD;
        const padY = bb.h * PAD;
        const left   = Math.max(0, Math.round((bb.x - padX) * W));
        const top    = Math.max(0, Math.round((bb.y - padY) * H));
        const right  = Math.min(W, Math.round((bb.x + bb.w + padX) * W));
        const bottom = Math.min(H, Math.round((bb.y + bb.h + padY) * H));
        const width  = right - left;
        const height = bottom - top;
        if (width < 32 || height < 32) {
          console.warn(`[BINDER] crop ${i}: too small (${width}x${height}) — skipping`);
          return null;
        }
        const ratio = width / height;
        const ratioFlag = (ratio < 0.55 || ratio > 0.95) ? ' [SUSPECT — not card-shaped]' : '';
        console.log(`[BINDER] crop ${i}: ${width}x${height} px, w/h=${ratio.toFixed(2)}${ratioFlag}${bb.hint ? `, hint="${bb.hint}"` : ''}`);
        try {
          const cropBuf = await sharp(buffer)
            .extract({ left, top, width, height })
            .jpeg({ quality: 92 })
            .toBuffer();
          return { buffer: cropBuf, hint: bb.hint || '', bbox: { left, top, width, height }, index: i };
        } catch (e) {
          console.warn(`[BINDER] crop ${i} extract failed:`, e.message);
          return null;
        }
      }));
      const validCrops = crops.filter(Boolean);

      // Identify each crop in parallel — full identifyCore + verify pipeline
      // per pocket. See block comment above for the concurrency ceiling.
      const results = await Promise.all(validCrops.map(async (crop) => {
        try {
          const out = await identifyCore({ buffer: crop.buffer, hint: crop.hint });
          if (out.cached) {
            return { cards: out.result.cards || [], bbox: crop.bbox, cached: true };
          }
          let cards = out.parsed.cards || [];
          if (cards.length > 0) {
            try {
              cards = await verifyIdentified(cards);
              cards = await doubleCheckAll(out.imageBase64, out.imageMediaType, cards);
            } catch (e) {
              console.warn(`[BINDER] verify failed for crop ${crop.index}, using unverified:`, e.message);
            }
          }
          const anyRejected = cards.some((c) => c?.verify_rejected);
          cards = stripInternals(cards);
          if (out.cacheKey && !anyRejected) cacheSet(out.cacheKey, { cards });
          return { cards, bbox: crop.bbox, cached: false };
        } catch (e) {
          console.warn(`[BINDER] identify failed for crop ${crop.index}:`, e.message);
          return { cards: [], bbox: crop.bbox, error: e.message };
        }
      }));

      // Flatten — each crop usually yields one card, but identifyCore is
      // technically multi-card so don't drop any. Attach the source bbox
      // and the cropped image (as a data URL) so the UI can show
      // "what you scanned" alongside "what we identified". 12 cards × ~80KB
      // q92 JPEG ≈ 1MB response — acceptable for a one-shot binder upload.
      //
      // Filter: drop crops that produced ZERO cards or only cards without
      // a name. A bbox with nothing identifiable behind it is almost
      // always a Sonnet false positive (glare, sleeve, empty pocket); it
      // shouldn't reach the operator's session log as a junk row. The
      // skipped count is reported back so the UI can surface "we
      // detected N, identified M".
      const flat = [];
      let droppedFalsePositives = 0;
      let droppedExtraCardsPerCrop = 0;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const namedCards = (r.cards || []).filter((c) => c && c.name && !c.verify_rejected);
        if (namedCards.length === 0) {
          droppedFalsePositives++;
          console.log(`[BINDER] crop ${validCrops[i]?.index ?? i}: no identifiable card — dropping false positive`);
          continue;
        }
        // Each binder crop is supposed to contain ONE card. If identifyCore
        // returned multiple, Sonnet saw something extra — typically a
        // water/lightning/grass-element splash on a holo art read as a
        // Basic Water Energy alongside the real card. Sonnet's order is
        // not reliable: sometimes the phantom comes first (which would
        // make "take first" drop the real card — an earlier bug).
        //
        // Decision rule: if multiple cards came back and exactly one is
        // a non-energy, that's the real card and the rest are
        // basic-energy phantoms. Otherwise the result is genuinely
        // ambiguous — take the first and log everything for diagnosis.
        const primary = pickPrimaryCard(namedCards);
        if (namedCards.length > 1) {
          droppedExtraCardsPerCrop += namedCards.length - 1;
          const dropped = namedCards.filter((c) => c !== primary);
          console.warn(
            `[BINDER] crop ${validCrops[i]?.index ?? i}: identifyCore returned ${namedCards.length} cards — ` +
            `keeping "${primary.name}" (${primary.set_code || '?'} ${primary.card_number || '?'}), ` +
            `dropping: ${dropped.map((c) => `${c.name} ${c.set_code || '?'} ${c.card_number || '?'}`).join(', ')}`,
          );
        }
        const cropBuf = validCrops[i]?.buffer;
        const cropDataUrl = cropBuf
          ? 'data:image/jpeg;base64,' + cropBuf.toString('base64')
          : null;
        flat.push({
          ...primary,
          _binder_bbox: r.bbox,
          _binder_image: cropDataUrl,
        });
      }
      console.log(
        `[BINDER] done in ${Date.now() - t0}ms — ${bboxes.length} detected, ` +
        `${validCrops.length} cropped, ${flat.length} identified, ` +
        `${droppedFalsePositives} false positives, ${droppedExtraCardsPerCrop} extra-per-crop ` +
        `(${results.filter((r) => r.cached).length} cached)`,
      );
      return res.json({
        cards: flat,
        binder: {
          count: bboxes.length,
          cropped: validCrops.length,
          identified: flat.length,
          dropped: droppedFalsePositives,
          dropped_extra: droppedExtraCardsPerCrop,
          image_w: W,
          image_h: H,
          detection_path: detectionPath,
        },
      });
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message });
      console.error('[BINDER] error:', err.message);
      res.status(500).json({ error: 'Failed to identify binder page', details: err.message });
    }
  }
);

// V1 server.js:2447-2672 — manual identify body, extracted to a shared
// helper so both the auth'd V1 path and the public V2 quote path share
// identical lookup logic. See S8.5 fix below.
//
// S15 refactor: split the route-shaped wrapper from the pure-function
// core so the OCR-first pipeline (pricing/ocr-first/pipeline.js) can call
// the lookup logic without a synthetic req/res. Behaviour preserved 1:1 —
// the wrapper translates the structured envelope back to res.status/json.

/**
 * Pure async function: take normalised inputs, return either
 *   { cards: [<card>] }
 *   { error: '...', status: 400|404|500 }
 * No req/res, no rate-limit, no quota, no telemetry. Caller owns those.
 *
 * Inputs accepted:
 *   - game        (REQUIRED) 'pokemon' | 'magic' | <other> — case-sensitive
 *   - set_code    optional set abbreviation; aliases resolved internally
 *   - card_number REQUIRED; "/total" suffix stripped, leading zeros trimmed
 *   - name        optional name hint (helps disambiguate)
 */
async function manualIdentifyCore({ game, set_code, card_number, name } = {}) {
  if (!game) return { error: 'game is required', status: 400 };
  if (!card_number) return { error: 'card_number is required', status: 400 };

  const cleanNum = String(card_number).replace(/\/.*/, '').replace(/^0+/, '') || String(card_number);
  let card = null;

  try {
    if (game === 'pokemon') {
      const resolved = set_code ? resolveSetCode(set_code) : { setId: null, ptcgoCode: null };

      if (resolved.setId) {
        card = lookupLocalDb(resolved.setId, cleanNum);
        if (card) {
          console.log(`[MANUAL-PKM] Local DB hit: ${card.name} (${resolved.setId}-${cleanNum})`);
          return { cards: [card] };
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
      return { error: 'No card found for that set/number combination. Double-check the set code and number.', status: 404 };
    }

    if (card.game === 'pokemon' && set_code) {
      const resolved2 = resolveSetCode(set_code);
      if (resolved2.setId) {
        cacheCardResult(resolved2.setId, cleanNum, card);
      }
    }

    return { cards: [card] };
  } catch (err) {
    console.error('[MANUAL] Error:', err.message);
    return { error: err.message, status: 500 };
  }
}

// Thin route-shaped wrapper. Translates the manualIdentifyCore envelope
// back to res.status/res.json. Existing tests (S8.5
// quote-public-paths.spec.js) call this with (req, res) — preserved.
async function handleManualIdentify(req, res) {
  const result = await manualIdentifyCore(req.body || {});
  if (result && result.error) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  return res.json({ cards: result.cards });
}

// V1 auth'd manual-identify (vendor-side). Logs scan event against the
// authenticated user; enforceQuota writes X-Scan-* headers.
router.post('/api/identify-manual', requireAuth, enforceQuota, async (req, res) => {
  logScanEvent(req.user.id, '/api/identify-manual');
  return handleManualIdentify(req, res);
});

// S8.5 fix — public quote-side manual identify. /quote.html and apps/quote
// were silently failing with 401s because they call this endpoint as
// anonymous customers. Same lookup logic as /api/identify-manual but no
// requireAuth; rate-limited via quoteLeadLimiter (10/hr per IP) — the
// terminal quote-lead step is already gated by the same limiter, so the
// whole customer flow shares one bucket.
//
// logScanEvent(null, ...) is a no-op (the helper bails when userId is
// falsy), so we skip calling it here — there's no user to attribute
// to and scan_events.user_id is NOT NULL.
router.post('/api/v2/quote/identify-manual', quoteLeadLimiter, async (req, res) => {
  return handleManualIdentify(req, res);
});

// =============================================================================
// READ-SET-CODE — V1 server.js:2681-2830.
//
// S15 split: the OCR work (sharp resize → Sonnet 4.6 → post-process)
// is now a pure helper `readSetCodeFromImage({buffer, mediaType})` that
// the OCR-first pipeline (pricing/ocr-first/pipeline.js) calls directly,
// bypassing the data-URL decoding and HTTP layer. Public endpoint shape
// is preserved 1:1.
// =============================================================================

const READ_SET_CODE_PROMPT = `Read the set code and card number printed on this Pokemon card. Look near the bottom of the card for small text.

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

Return ONLY the set code and number. If you cannot read any set code, respond: NONE`;

// SET_TOTALS lookup for the post-processing cross-check
// (corrects MEP→MEG when the printed total /132 matches MEG, not MEP).
const READ_SET_CODE_TOTALS = {
  'MEG':'132','PFL':'094','POR':'088','WHT':'086','BBT':'086',
  'DRI':'182','SSP':'191','SVI':'198','MEW':'165','DIA':'182',
  'PAL':'198','OBF':'197','PAR':'182','PAF':'091','TEF':'162',
  'TWM':'167','SFA':'064','SCR':'156','PRE':'175','JTG':'182',
  'SSH':'202','RCL':'192','DAA':'189','VIV':'185','BST':'163',
  'CRE':'198','EVS':'203','FST':'264','BRS':'172','ASR':'189',
  'LOR':'196','SIT':'195','CRZ':'230',
};

/**
 * Pure-function OCR pass that returns the printed set code + card number.
 * Resizes large images via sharp before sending to Sonnet 4.6 (matches V1
 * 4MB threshold + 3200px / q98 settings). Post-processing strips markdown
 * and runs the set-total cross-check — both verbatim from V1.
 *
 * Used by:
 *   - POST /api/read-set-code  (route handler below)
 *   - POST /api/v2/identify-ocr-first  (via runOcrFirst)
 *
 * Returns:
 *   { text: 'MEP 027' }   — happy path
 *   { error: 'Could not read set code from image' }
 *   { error: <message> }  — Sonnet/sharp failure
 *
 * @param {object} args
 * @param {Buffer} args.buffer     Raw image bytes.
 * @param {string} args.mediaType  'image/jpeg' | 'image/png' | ...
 */
export async function readSetCodeFromImage({ buffer, mediaType } = {}) {
  if (!buffer) return { error: 'No image provided' };
  try {
    let imageBase64, sendMediaType;
    if (buffer.length > 4 * 1024 * 1024) {
      const resized = await sharp(buffer)
        .resize({ width: 3200, withoutEnlargement: true })
        .jpeg({ quality: 98 })
        .toBuffer();
      imageBase64 = resized.toString('base64');
      sendMediaType = 'image/jpeg';
      console.log(`[READ-SET-CODE] Resized (too large): ${(buffer.length/1024).toFixed(0)}KB → ${(resized.length/1024).toFixed(0)}KB`);
    } else {
      imageBase64 = buffer.toString('base64');
      sendMediaType = mediaType || 'image/jpeg';
      console.log(`[READ-SET-CODE] Passthrough: ${(buffer.length/1024).toFixed(0)}KB (${sendMediaType})`);
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
            source: { type: 'base64', media_type: sendMediaType, data: imageBase64 }
          },
          { type: 'text', text: READ_SET_CODE_PROMPT }
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

    const totalMatch = raw.match(/^([A-Z]{2,4})\s+(\d+)\s*\/\s*(\d+)$/);
    if (totalMatch) {
      const [, readCode, cardNum, total] = totalMatch;
      const expectedTotal = READ_SET_CODE_TOTALS[readCode];
      if (expectedTotal && expectedTotal !== total) {
        const correctCode = Object.entries(READ_SET_CODE_TOTALS).find(([, t]) => t === total)?.[0];
        if (correctCode) {
          const corrected = `${correctCode} ${cardNum}/${total}`;
          console.log(`[READ-SET-CODE] CORRECTED: "${raw}" → "${corrected}" (total /${total} matches ${correctCode}, not ${readCode})`);
          raw = corrected;
        }
      }
    }

    console.log(`[READ-SET-CODE] ${elapsed}ms → final "${raw}"`);

    if (!raw || raw === 'NONE') {
      return { error: 'Could not read set code from image' };
    }
    return { text: raw };
  } catch (err) {
    console.error('[READ-SET-CODE] Error:', err.message, err.status || '', err.error?.message || '');
    return { error: err.message };
  }
}

// V1 endpoint: thin shim around readSetCodeFromImage. Decodes the data URL
// from req.body.image, then delegates. Response shape preserved 1:1.
router.post('/api/read-set-code', identifyLimiter, requireAuth, enforceQuota, async (req, res) => {
  logScanEvent(req.user.id, '/api/read-set-code');
  const dataUrl = req.body?.image;
  if (!dataUrl) {
    return res.status(400).json({ error: 'No image provided' });
  }
  const match = dataUrl.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
  if (!match) {
    return res.status(400).json({ error: 'Invalid image data URL' });
  }
  const rawBuffer = Buffer.from(match[2], 'base64');
  const result = await readSetCodeFromImage({ buffer: rawBuffer, mediaType: match[1] });
  if (result.error) {
    // V1 mapped 'Could not read set code from image' to 404, anything else
    // (sharp/anthropic failures) to 500. Preserve the split.
    const status = /Could not read set code/.test(result.error) ? 404 : 500;
    return res.status(status).json({ error: result.error });
  }
  return res.json({ text: result.text });
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

// =============================================================================
// /api/v2/identify-ocr-first — S15 OCR-first scan path (Q3, F24).
//
// Server-side kill switch: if OCR_FIRST_ENABLED !== 'true' the route returns
// 503 immediately, no Anthropic call, no telemetry write. Default off per
// infra/render.yaml + infra/env.example.
//
// On any non-503 outcome the pipeline writes one scan_events row with
// endpoint='ocr-first' (telemetry honest regardless of validated/fell
// through outcome) and increments cardpricer_ocr_first_total.
//
// The client treats {validated:false} as "go run /api/identify-stream the
// slow way" — same UX as today. The OCR-first path is purely a fast happy
// path. The logScanEvent at the top of the handler keeps the V1 quota
// accounting honest (one scan = one quota tick, regardless of which path
// served it).
// =============================================================================
router.post('/api/v2/identify-ocr-first',
  identifyLimiter,
  requireAuth,
  enforceQuota,
  upload.single('image'),
  async (req, res) => {
    if (process.env.OCR_FIRST_ENABLED !== 'true') {
      return res.status(503).json({
        error: 'ocr_first_disabled',
        enable_with: 'OCR_FIRST_ENABLED=true',
      });
    }

    // Per-attempt quota tick + classic scan_events row (no `data` payload).
    // The pipeline writes a SECOND row with endpoint='ocr-first' + data jsonb;
    // the V1 row keeps quota accounting consistent with /api/identify.
    logScanEvent(req.user.id, '/api/v2/identify-ocr-first');

    try {
      const buffer = extractImageBuffer(req);
      // multer / data URL paths both decode bytes; we don't have a strict
      // media-type from multer for raw uploads, so default to JPEG (matches
      // identifyCore's behaviour for the client-resized data URL path).
      const mediaType = req.file?.mimetype || 'image/jpeg';
      const hint = req.body?.hint || '';

      const out = await runOcrFirst({
        buffer,
        mediaType,
        hint,
        ctx: { userId: req.user.id },
        deps: {
          readSetCodeFromImage,
          manualIdentifyCore,
        },
      });

      return res.json(out);
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message });
      console.error('[OCR-FIRST] error:', err.message);
      return res.status(500).json({ error: 'Failed to run OCR-first identify', details: err.message });
    }
  }
);

// Named exports for tests + the OCR-first pipeline:
//   - handleManualIdentify     (S8.5 — quote-public-paths.spec.js)
//   - manualIdentifyCore       (S15 — pricing/ocr-first/pipeline.js calls
//                               this directly via the deps object)
//   - readSetCodeFromImage     (already exported inline above; here for
//                               documentation symmetry).
export { handleManualIdentify, manualIdentifyCore };

export default router;
