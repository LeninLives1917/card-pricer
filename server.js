import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
// Render puts us behind its edge proxy; without this, every request appears
// to come from the proxy IP and per-IP rate limits would collapse into one bucket.
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ============================================================
// RATE LIMITS — protect paid upstreams (Anthropic, Brevo) from abuse
// ============================================================
// Scanning endpoints: generous enough for a real card-show session (you can
// easily scan 1/sec for minutes), but capped so a script-kiddie can't drain
// the Anthropic budget in an afternoon.
const identifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many identify requests — slow down.' }
});
// Quote-lead triggers Brevo emails. Much lower cap because a single abuser
// spamming this drains email-send quota and could mark the domain as spammy.
const quoteLeadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many quote requests — please try again later.' }
});

// ============================================================
// USD → EUR — refreshed daily from Frankfurter (ECB data, no auth needed).
// ============================================================
// Used to convert TCGPlayer USD prices into EUR for buy-offer calculations.
// Initial value is last-known reasonable; refresh updates it on boot + daily.
let USD_TO_EUR = 0.92;
async function refreshFxRate() {
  try {
    const resp = await axios.get('https://api.frankfurter.app/latest', {
      params: { from: 'USD', to: 'EUR' },
      timeout: 10000
    });
    const rate = resp.data?.rates?.EUR;
    if (typeof rate === 'number' && rate > 0.5 && rate < 2.0) {
      USD_TO_EUR = rate;
      console.log(`[FX] USD→EUR refreshed: ${rate.toFixed(4)} (frankfurter.app, ${resp.data.date})`);
    } else {
      console.warn(`[FX] Unexpected rate shape — keeping ${USD_TO_EUR}`, rate);
    }
  } catch (e) {
    console.warn(`[FX] Refresh failed — keeping ${USD_TO_EUR}: ${e.message}`);
  }
}
refreshFxRate();
setInterval(refreshFxRate, 24 * 60 * 60 * 1000);
// Force no-cache on service-worker.js and index.html to bust PWA staleness
app.get('/service-worker.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(join(__dirname, 'public', 'service-worker.js'));
});
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(join(__dirname, 'public', 'index.html'));
});
app.use(express.static(join(__dirname, 'public'), { etag: false, maxAge: 0 }));

// Multer for file uploads (in-memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

// ============================================================
// ANTHROPIC CLIENT — Card Identification via Claude Vision
// ============================================================
// Keep-alive agents so we reuse TCP/TLS connections to Anthropic (and axios
// upstreams). Without this, every /api/identify eats a fresh TLS handshake
// (~150-300ms on cellular). keepAlive=true reuses the socket for ~60s.
const httpsKeepAlive = new https.Agent({ keepAlive: true, maxSockets: 25, keepAliveMsecs: 30_000 });
const httpKeepAlive = new http.Agent({ keepAlive: true, maxSockets: 25, keepAliveMsecs: 30_000 });
axios.defaults.httpsAgent = httpsKeepAlive;
axios.defaults.httpAgent = httpKeepAlive;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // Pass our keep-alive https agent through the SDK's fetch so Anthropic
  // calls reuse sockets too.
  fetchOptions: { agent: httpsKeepAlive }
});

const CARD_ID_SYSTEM_PROMPT = `You are an expert trading card identifier with encyclopaedic knowledge of ALL trading card games. You can identify cards with extreme accuracy from:

- Pokemon TCG
- Magic: The Gathering
- Star Wars: Unlimited (FFG/Spark of Rebellion, Shadows of the Galaxy, Twilight of the Republic, etc.)
- One Piece TCG
- Yu-Gi-Oh!
- Dragon Ball Super Card Game
- Disney Lorcana
- Digimon Card Game
- Flesh and Blood
- Weiss Schwarz
- Cardfight!! Vanguard
- Final Fantasy TCG
- MetaZoo
- Union Arena
- Battle Spirits Saga
- ANY other TCG

When shown a card image, you MUST return ONLY valid JSON (no markdown, no explanation) in this exact format:

For a SINGLE card:
{
  "cards": [{
    "game": "pokemon|magic|starwars|onepiece|yugioh|dragonball|lorcana|digimon|fleshandblood|weiss|cardfight|other",
    "name": "Exact card name as printed on the card (include ex/GX/V/VMAX/VSTAR suffix if present)",
    "hp": "HP number as printed (e.g. 330, 250, 120) — CRITICAL for Pokemon",
    "attacks": ["Attack Name 1", "Attack Name 2"],
    "set_name": "Full set name",
    "set_code": "Set code/abbreviation",
    "card_number": "Card number exactly as printed (e.g. 025/252, SOR 051, OP06-001)",
    "rarity": "Common/Uncommon/Rare/Super Rare/Legendary/Hyperspace/etc",
    "variant": "normal|holofoil|reverse_holo|full_art|alt_art|textured|gold|hyperspace|showcase|special",
    "language": "english|japanese|german|french|italian|spanish|other",
    "condition_estimate": "NM|LP|MP|HP|DMG",
    "condition_notes": "Brief notes on visible wear, whitening, scratches, etc.",
    "graded": null,
    "confidence": 0.95
  }]
}

If the card is in a professional GRADING SLAB (a hard plastic case with a colored label showing a grade), populate the "graded" field INSTEAD of leaving it null:
  "graded": { "company": "PSA|BGS|CGC|SGC", "grade": 10 }
Visual cues for slabs:
- PSA: red label at top, large white number, black holographic logo. Grades 1-10.
- BGS (Beckett): black label (standard) or silver/gold (premium), sub-grades visible, "BGS" logo.
- CGC: blue/teal label, "CGC Trading Cards" text.
- SGC: tuxedo (black+white) label.
When graded is set, still estimate condition_estimate as if ungraded (will be overridden) and keep everything else accurate.

For a BINDER PAGE with multiple cards:
{
  "cards": [
    { ...card1... },
    { ...card2... },
    ...
  ],
  "layout": "3x3|4x3|3x2|etc",
  "notes": "Any notes about partially visible or unidentifiable cards"
}

=== GAME-SPECIFIC IDENTIFICATION GUIDES ===

STAR WARS: UNLIMITED (game="starwars"):
- Set codes: SOR (Spark of Rebellion), SHD (Shadows of the Galaxy), TWI (Twilight of the Republic), JTL (Jump to Lightspeed)
- Card number format: "SOR 051" or "051/252" — check the BOTTOM of the card
- Rarity indicators: Common (no marking), Uncommon (U), Rare (R), Super Rare (SR), Legendary (L), Special (S)
- CRITICAL: Variants have VERY different prices:
  - Normal: standard card art
  - Hyperspace: alternate border style — typically 2-5x normal price
  - Showcase: special full art — can be 10-50x normal price
  - READ the card border and art style carefully to distinguish normal vs hyperspace vs showcase
- Characters include: Marchion Ro, Luke Skywalker, Darth Vader, Sabine Wren, Boba Fett, Grand Inquisitor, etc.
- Look for the FFG / Fantasy Flight Games logo
- The card type (Unit, Event, Upgrade, Base, Leader) is printed on the card

POKEMON TCG (game="pokemon"):
- CRITICAL: Read the EXACT suffix on the card name — "ex", "GX", "V", "VMAX", "VSTAR", "EX" (caps), "LV.X" are ALL DIFFERENT card types. Do NOT confuse them.
  - Lowercase "ex" = Scarlet & Violet era (2023+). VISUAL CUES: name on card shows lowercase "ex" in stylized font, card has "Pokemon ex rule" text at bottom, modern card frame, usually has regulation mark G or H. HP ranges from 120-340+.
  - Uppercase "GX" = Sun & Moon era (2017-2020). VISUAL CUES: name shows uppercase "GX" in bold, card has "Pokemon-GX rule" text, has a special GX attack (used once per game), Sun & Moon era card frame with yellow/grey border. HP usually 170-270.
  - Uppercase "EX" (older) = XY era (2014-2016), has "Pokemon-EX rule"
  - "V" / "VMAX" / "VSTAR" = Sword & Shield era (2020-2023)
  - No suffix = regular Pokemon card
  - IMPORTANT: "Meowth ex" (lowercase, SV era, 170HP) is NOT "Meowth-GX" (uppercase with hyphen, SM era). Read the actual text printed on the card name area carefully!
- READ the HP number printed on the card — this is essential for distinguishing versions (e.g. Charizard ex 330HP vs Charizard GX 250HP)
- READ all attack names printed on the card — different versions have completely different attacks
- Set codes: SV (Scarlet & Violet base), PAL (Paldea Evolved), OBF (Obsidian Flames), MEW (151), PAR (Paradox Rift), PAF (Paldean Fates), TEF (Temporal Forces), TWM (Twilight Masquerade), SFA (Shrouded Fable), SSP (Stellar Crown), SCR (Surging Sparks), PRE (Prismatic Evolutions), JTG (Journey Together), SM (Sun & Moon sets), SV (Sword & Shield sets)
- Include HP in your identification to disambiguate: e.g. "Charizard ex" with 330 HP is NOT "Charizard GX" with 250 HP

*** CARD NUMBER IS THE #1 MOST IMPORTANT FIELD — READ IT FROM THE CARD BOTTOM ***
- BEFORE anything else, look at the BOTTOM of the card for the printed card number
- The card number is typically at the BOTTOM LEFT of the card, printed in small text
- PROMO CARDS have special numbering WITHOUT a slash:
  - Sun & Moon promos: "SM211", "SM195", "SM228" — these are NOT from any main set
  - Sword & Shield promos: "SWSH262", "SWSH066" — also standalone promos
  - Scarlet & Violet promos: "SVP 076" — note the SVP prefix
  - Black Star promos have numbers like "XY121", "BW78"
  - If you see a number like "SM211" with no "/" it is a PROMO, NOT from Hidden Fates, Shiny Vault, or any expansion set
- SET CARDS have a slash format: "006/197", "SV49/SV94"
  - Shiny Vault cards use "SV" prefix: "SV49/SV94" (Hidden Fates), "SV122/SV122" (Shining Fates)
  - Regular art: typically low number (e.g. 006/197)
  - Full art: higher number (e.g. 185/197)
  - Special art rare / Illustration rare: even higher (e.g. 199/197, goes OVER the set total)
  - Hyper rare / Gold: highest numbers (e.g. 210/197)
- CRITICAL: "SM211" (Detective Pikachu promo Charizard-GX) is a COMPLETELY DIFFERENT card from "SV49/SV94" (Hidden Fates Shiny Vault Charizard-GX). Same Pokemon, same suffix, DIFFERENT cards with DIFFERENT values.
- A "Charizard ex 006/197" (regular art) is a COMPLETELY different card than "Charizard ex 199/197" (special art rare) — they can differ by hundreds in price
- READ the card number at the bottom of the card CAREFULLY. The number before "/" and the total after "/" are both important.
- If you see NO slash in the number (e.g. "SM211"), set set_name to the promo series (e.g. "SM Black Star Promos") and set_code to "SMP" (or "SWSHP", "SVP" for those eras)
- If the card number is LARGER than the set total (e.g. 199/197), it is a secret rare / special art
- Distinguish: holo, reverse holo, full art, illustration rare, special art rare (SAR), hyper rare, gold, ultra rare, amazing rare
- NEVER guess the card number — if you cannot read it clearly, return "" rather than guessing a number from a different card

MAGIC: THE GATHERING (game="magic"):
- Check set symbol (bottom right) and collector number (bottom left)
- Format: "123/456" — be precise. Numbers ABOVE the set total are borderless/extended art/showcase variants
- CRITICAL: Same card can appear as regular, borderless, extended art, showcase, retro frame, foil etched — each has a DIFFERENT collector number and very different prices
- Look for the mana symbols to confirm MTG
- Serialized cards (e.g. "001/500") are extremely valuable — note this in variant field

ONE PIECE TCG (game="onepiece"):
- Set codes: OP01, OP02, OP03, OP04, OP05, OP06, OP07, OP08, OP09, ST01-ST18
- Card number format: "OP06-001" — the set code is part of the number
- Types: Leader, Character, Event, Stage, DON!!

YU-GI-OH! (game="yugioh"):
- Card number format: "ABCD-EN001" — the set prefix + language + number
- Check the edition (1st Edition, Unlimited, Limited Edition)
- Rarity: Common, Rare, Super Rare, Ultra Rare, Secret Rare, Ghost Rare, Starlight Rare

DISNEY LORCANA (game="lorcana"):
- Set codes: TFC (The First Chapter), RotF (Rise of the Floodborn), ItI (Into the Inklands), URR (Ursula's Return), SSK (Shimmering Skies), AP (Azurite Sea)
- Card number format: "123/204"
- Check ink colour (Amber, Amethyst, Emerald, Ruby, Sapphire, Steel)

=== CRITICAL ACCURACY RULES ===
- READ the EXACT card name as printed — DO NOT guess or use a similar card name
- READ the EXACT suffix: "ex" (lowercase) ≠ "GX" ≠ "EX" (uppercase) ≠ "V" ≠ "VMAX" ≠ "VSTAR". Getting this wrong gives completely wrong prices.
- READ the HP number — this distinguishes card versions (e.g. 330HP vs 250HP Charizard)
- READ the attack names — different versions have different attacks. Include them in the "attacks" array.
- READ the EXACT card number printed on the card — this is the #1 most important field for pricing
  - INCLUDE the full number with set total, e.g. "44/95" not just "44" — the total after "/" identifies which set it belongs to
  - For EX-era Pokemon cards (2003-2007), the set total is critical because many common Pokemon appear across multiple sets with the same number
  - Example: Psyduck #44 exists in multiple EX-era sets — only the "/95" or "/116" etc. tells us WHICH set
- READ the set symbol carefully — it appears at the bottom right of Pokemon cards and uniquely identifies the set
- If image is blurry, partially obscured, or you're not certain, set confidence below 0.5
- For condition: look for edge whitening, surface scratches, centering issues, corner wear
- NEVER fabricate a card number — if you can't read it clearly, use "" and note why
- If you can identify the game but not the specific card, still set the game field correctly
- Pay close attention to foil/holo patterns visible in the image`;

// ============================================================
// CARD IDENTIFICATION ENDPOINT
// ============================================================
// Simple LRU cache for recent identifications (keyed by image hash).
// Re-scanning the same card (camera double-fires, operator re-scans)
// returns instantly instead of re-hitting Claude.
const IDENT_CACHE_MAX = 100;
const identCache = new Map();
function cacheGet(key) {
  if (!identCache.has(key)) return null;
  const val = identCache.get(key);
  // Re-insert to mark as recently used
  identCache.delete(key);
  identCache.set(key, val);
  return val;
}
function cacheSet(key, val) {
  if (identCache.has(key)) identCache.delete(key);
  identCache.set(key, val);
  if (identCache.size > IDENT_CACHE_MAX) {
    const first = identCache.keys().next().value;
    identCache.delete(first);
  }
}

app.post('/api/identify', identifyLimiter, upload.single('image'), async (req, res) => {
  try {
    const isBatchMode = req.body.batch === 'true' || req.body.batch === true;

    // Batch (binder page) keeps full resolution + Sonnet — accuracy critical.
    // Single-card mode gets aggressive resize + Haiku — speed critical.
    // 700px is enough for Haiku to read card numbers cleanly while cutting
    // payload by ~40% vs 900px (quadratic in dimension).
    const targetSize = isBatchMode ? 1500 : 1100;
    const jpegQuality = isBatchMode ? 90 : 88;

    let imageData;
    let mediaType;
    let rawBuffer;

    if (req.file) {
      rawBuffer = req.file.buffer;
    } else if (req.body.image) {
      const base64Match = req.body.image.match(/^data:(image\/\w+);base64,(.+)$/);
      if (base64Match) {
        rawBuffer = Buffer.from(base64Match[2], 'base64');
      } else {
        return res.status(400).json({ error: 'Invalid image data' });
      }
    } else {
      return res.status(400).json({ error: 'No image provided' });
    }

    const optimized = await sharp(rawBuffer)
      .resize(targetSize, targetSize, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: jpegQuality })
      .toBuffer();
    imageData = optimized.toString('base64');
    mediaType = 'image/jpeg';

    // Cache lookup — only for single-card mode, and only when no user hint
    // (a hint changes the expected output).
    const userHint = req.body.hint || '';
    let cacheKey = null;
    if (!isBatchMode && !userHint) {
      cacheKey = crypto.createHash('sha1').update(optimized).digest('hex');
      const hit = cacheGet(cacheKey);
      if (hit) {
        console.log(`[IDENT-CACHE] HIT ${cacheKey.slice(0, 8)}`);
        return res.json(hit);
      }
    }

    let userMessage = isBatchMode
      ? 'This is a photo of a binder page with MULTIPLE trading cards. Identify EVERY visible card individually. Return all cards in the JSON array.'
      : 'Identify this trading card. FIRST read the card number at the bottom of the card — this is the most critical field. If it has no slash (like SM211, SWSH066) it is a PROMO card. Be extremely precise with the set code and card number.';

    if (userHint) {
      userMessage += `\n\nUser hint: ${userHint}`;
    }

    // Haiku 4.5 for single-card ID (fast + cheap, plenty accurate for reading
    // a card number + name). Sonnet 4 for batch binder pages (needs to see
    // many small cards accurately).
    // Sonnet for both single-card and batch — Haiku was misreading card
    // numbers (e.g. 223 → 225) even at higher resolutions. Accuracy > speed.
    const model = 'claude-sonnet-4-20250514';

    const response = await anthropic.messages.create({
      model,
      max_tokens: isBatchMode ? 4096 : 1024,
      // Prompt caching: system prompt is ~1500 tokens and identical on every
      // call. Marking it ephemeral lets Anthropic reuse the cached KV compute
      // for 5 min, shaving 30-50% off TTFT with zero accuracy risk.
      system: [{
        type: 'text',
        text: CARD_ID_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }
      }],
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: imageData }
          },
          { type: 'text', text: userMessage }
        ]
      }]
    });

    const text = response.content[0].text;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Could not parse card identification response');
      }
    }

    // PRE-VERIFY: Fix obvious AI mistakes before database lookup
    if (parsed.cards && parsed.cards.length > 0) {
      parsed.cards = parsed.cards.map(card => fixPokemonSuffix(card));
    }

    // VERIFY each card against real databases to correct set info
    if (parsed.cards && parsed.cards.length > 0) {
      console.log(`[VERIFY] Verifying ${parsed.cards.length} card(s) against databases...`);
      parsed.cards = await Promise.all(parsed.cards.map(card => verifyCard(card)));
    }

    const anyRejected = (parsed.cards || []).some(c => c?.verify_rejected);
    if (cacheKey && !anyRejected) cacheSet(cacheKey, parsed);
    res.json(parsed);
  } catch (err) {
    console.error('Identification error:', err.message);
    res.status(500).json({ error: 'Failed to identify card', details: err.message });
  }
});

// ============================================================
// STREAMING IDENTIFY: /api/identify-stream
// ============================================================
// NDJSON-over-HTTP. Emits events as they become available:
//   {type:'ident', cards}    — raw Claude output (unverified) — client can
//                              start pricing off this immediately.
//   {type:'verified', cards} — same cards after DB verification (may rename
//                              set_code / card_number). Client patches UI.
//   {type:'error', error}
//   {type:'done'}
// This shaves 500-1000ms off perceived latency because pricing kicks off
// before the (slow) pokemontcg.io / scryfall verification round-trip.
app.post('/api/identify-stream', identifyLimiter, upload.single('image'), async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (obj) => {
    try { res.write(JSON.stringify(obj) + '\n'); } catch {}
  };

  try {
    const isBatchMode = req.body.batch === 'true' || req.body.batch === true;
    const targetSize = isBatchMode ? 1500 : 1100;
    const jpegQuality = isBatchMode ? 90 : 88;

    let rawBuffer;
    if (req.file) {
      rawBuffer = req.file.buffer;
    } else if (req.body.image) {
      const base64Match = req.body.image.match(/^data:(image\/\w+);base64,(.+)$/);
      if (base64Match) rawBuffer = Buffer.from(base64Match[2], 'base64');
      else { send({ type: 'error', error: 'Invalid image data' }); return res.end(); }
    } else {
      send({ type: 'error', error: 'No image provided' }); return res.end();
    }

    const optimized = await sharp(rawBuffer)
      .resize(targetSize, targetSize, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: jpegQuality })
      .toBuffer();
    const imageData = optimized.toString('base64');

    const userHint = req.body.hint || '';
    let cacheKey = null;
    if (!isBatchMode && !userHint) {
      cacheKey = crypto.createHash('sha1').update(optimized).digest('hex');
      const hit = cacheGet(cacheKey);
      if (hit) {
        console.log(`[IDENT-STREAM-CACHE] HIT ${cacheKey.slice(0, 8)}`);
        // Already verified in cache — emit both events so client logic works.
        send({ type: 'ident', cards: hit.cards || [] });
        send({ type: 'verified', cards: hit.cards || [] });
        send({ type: 'done' });
        return res.end();
      }
    }

    let userMessage = isBatchMode
      ? 'This is a photo of a binder page with MULTIPLE trading cards. Identify EVERY visible card individually. Return all cards in the JSON array.'
      : 'Identify this trading card. FIRST read the card number at the bottom of the card — this is the most critical field. If it has no slash (like SM211, SWSH066) it is a PROMO card. Be extremely precise with the set code and card number.';
    if (userHint) userMessage += `\n\nUser hint: ${userHint}`;

    // Sonnet for both single-card and batch — Haiku was misreading card
    // numbers (e.g. 223 → 225) even at higher resolutions. Accuracy > speed.
    const model = 'claude-sonnet-4-20250514';

    const response = await anthropic.messages.create({
      model,
      max_tokens: isBatchMode ? 4096 : 1024,
      system: [{
        type: 'text',
        text: CARD_ID_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }
      }],
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageData } },
          { type: 'text', text: userMessage }
        ]
      }]
    });

    const text = response.content[0].text;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
      else throw new Error('Could not parse card identification response');
    }

    if (parsed.cards && parsed.cards.length > 0) {
      parsed.cards = parsed.cards.map(card => fixPokemonSuffix(card));
    }

    // Emit ident NOW so client can start pricing in parallel with verification.
    send({ type: 'ident', cards: parsed.cards || [] });

    // Verify against real databases — this is the slow step (500-1500ms).
    if (parsed.cards && parsed.cards.length > 0) {
      try {
        parsed.cards = await Promise.all(parsed.cards.map(card => verifyCard(card)));
      } catch (e) {
        console.error('[IDENT-STREAM] verify error:', e.message);
      }
    }
    send({ type: 'verified', cards: parsed.cards || [] });
    // Only cache if every card was either confidently verified or at least didn't fail verification.
    // Don't cache when verify rejected a card (e.g. HP mismatch unresolved) — re-scanning might
    // give us a better image and a better answer.
    const anyRejected = (parsed.cards || []).some(c => c?.verify_rejected);
    if (cacheKey && !anyRejected) cacheSet(cacheKey, parsed);
    else if (anyRejected) console.log(`[IDENT-STREAM-CACHE] SKIP — one or more cards had verify_rejected flag`);
    send({ type: 'done' });
    res.end();
  } catch (err) {
    console.error('Identify-stream error:', err.message);
    send({ type: 'error', error: err.message });
    res.end();
  }
});

// ============================================================
// POKEMON SET CODE ALIAS TABLE
// ============================================================
// Maps common abbreviations (ptcgoCode, printed codes, collector slang)
// to the pokemontcg.io set.id so manual lookups hit the right set.
// Keys are UPPERCASE. Values are the API's set.id (lowercase).
const PKM_SET_ALIASES = {
  // ---- Scarlet & Violet era ----
  'SVI':  'sv1',        // Scarlet & Violet
  'PAL':  'sv2',        // Paldea Evolved
  'OBF':  'sv3',        // Obsidian Flames
  'MEW':  'sv3pt5',     // Pokémon 151
  '151':  'sv3pt5',     // Pokémon 151 (alternate)
  'PAR':  'sv4',        // Paradox Rift
  'PAF':  'sv4pt5',     // Paldean Fates
  'TEF':  'sv5',        // Temporal Forces
  'TWM':  'sv6',        // Twilight Masquerade
  'SFA':  'sv6pt5',     // Shrouded Fable
  'SCR':  'sv7',        // Stellar Crown
  'SSP':  'sv8',        // Surging Sparks
  'PRE':  'sv8pt5',     // Prismatic Evolutions
  'SVE':  'sv8pt5',     // Prismatic Evolutions (alternate)
  'JTG':  'sv9',        // Journey Together
  'JT':   'sv9',        // Journey Together (short)
  'DRI':  'sv10',       // Destined Rivals
  // Black Bolt & White Flare (SV10.5 split expansion)
  'BBT':  'bbt',        // Black Bolt
  'BLK':  'bbt',        // Black Bolt (pokemontcg.io ptcgoCode)
  'ZSV10PT5': 'bbt',    // Black Bolt (pokemontcg.io set.id)
  'WHT':  'wht',        // White Flare
  'RSV10PT5': 'wht',    // White Flare (pokemontcg.io set.id)
  // Mega Evolution sub-sets (ME01/ME02/ME03)
  'MEG':  'me1',        // Mega Evolution (ME01)
  'ME1':  'me1',        // Mega Evolution (ME01 alternate)
  'PFL':  'me2',        // Phantasmal Flames (ME02)
  'ME2':  'me2',        // Phantasmal Flames (ME02 alternate)
  'ASH':  'me2pt5',     // Ascended Heroes (ME02.5)
  'POR':  'me3',        // Perfect Order (ME03)
  'ME3':  'me3',        // Perfect Order (ME03 alternate)
  // SV promo
  'SVP':  'svp',        // SV Black Star Promos
  // Mega Evolution promos
  'MEP':  'mep',        // MEP Black Star Promos (Mega Evolution Promos)

  // ---- Sword & Shield era ----
  'SSH':  'swsh1',      // Sword & Shield
  'RCL':  'swsh2',      // Rebel Clash
  'DAA':  'swsh3',      // Darkness Ablaze
  'VIV':  'swsh4',      // Vivid Voltage
  'BST':  'swsh5',      // Battle Styles
  'CRE':  'swsh6',      // Chilling Reign
  'EVS':  'swsh7',      // Evolving Skies
  'FST':  'swsh8',      // Fusion Strike
  'BRS':  'swsh9',      // Brilliant Stars
  'ASR':  'swsh10',     // Astral Radiance
  'LOR':  'swsh11',     // Lost Origin
  'SIT':  'swsh12',     // Silver Tempest
  'CRZ':  'swsh12pt5',  // Crown Zenith
  'CZGG': 'swsh12pt5gg', // Crown Zenith Galarian Gallery (GG01-GG70)
  'CPA':  'swsh35',     // Champion's Path
  'SHF':  'swsh45',     // Shining Fates
  'SWP':  'swshp',      // Sword & Shield promos (SWSH001-SWSH300)
  'SWSH': 'swshp',      // Sword & Shield promos (alternate)

  // ---- Sun & Moon era ----
  'SUM':  'sm1',        // Sun & Moon
  'GRI':  'sm2',        // Guardians Rising
  'BUS':  'sm3',        // Burning Shadows
  'SLG':  'sm35',       // Shining Legends
  'CIN':  'sm4',        // Crimson Invasion
  'UPR':  'sm5',        // Ultra Prism
  'FLI':  'sm6',        // Forbidden Light
  'CES':  'sm7',        // Celestial Storm
  'LOT':  'sm8',        // Lost Thunder
  'TEU':  'sm9',        // Team Up
  'UNB':  'sm10',       // Unbroken Bonds
  'UNM':  'sm11',       // Unified Minds
  'CEC':  'sm12',       // Cosmic Eclipse
  'HIF':  'sm35',       // Hidden Fates (shares with Shining Legends)
  'DET':  'det1',       // Detective Pikachu

  // ---- XY era ----
  'XY':   'xy1',        // XY
  'FLF':  'xy2',        // Flashfire
  'FFI':  'xy3',        // Furious Fists
  'PHF':  'xy4',        // Phantom Forces
  'PRC':  'xy5',        // Primal Clash
  'ROS':  'xy6',        // Roaring Skies
  'AOR':  'xy7',        // Ancient Origins
  'BKT':  'xy8',        // BREAKthrough
  'BKP':  'xy9',        // BREAKpoint
  'FCO':  'xy10',       // Fates Collide
  'STS':  'xy11',       // Steam Siege
  'EVO':  'xy12',       // Evolutions
  'GEN':  'g1',         // Generations
};

// Human-readable set names — used for TCGGO/JustTCG search fallback
// when pokemontcg.io doesn't have a set indexed.
const PKM_SET_NAMES = {
  'sv1':  'Scarlet & Violet',
  'sv2':  'Paldea Evolved',
  'sv3':  'Obsidian Flames',
  'sv3pt5': 'Pokemon 151',
  'sv4':  'Paradox Rift',
  'sv4pt5': 'Paldean Fates',
  'sv5':  'Temporal Forces',
  'sv6':  'Twilight Masquerade',
  'sv6pt5': 'Shrouded Fable',
  'sv7':  'Stellar Crown',
  'sv8':  'Surging Sparks',
  'sv8pt5': 'Prismatic Evolutions',
  'sv9':  'Journey Together',
  'sv10': 'Destined Rivals',
  'bbt':  'Black Bolt',
  'wht':  'White Flare',
  'me1':  'Mega Evolution',
  'me2':  'Phantasmal Flames',
  'me2pt5': 'Ascended Heroes',
  'me3':  'Perfect Order',
  'svp':  'SV Black Star Promos',
  'mep':  'Mega Evolution Promos',
  'swshp': 'Sword & Shield Promos',
  'swsh12pt5': 'Crown Zenith',
  'swsh12pt5gg': 'Crown Zenith Galarian Gallery',
};

// TCGdex set ID mapping — TCGdex uses different IDs than pokemontcg.io
// for some sets. We map our internal set.id → TCGdex set ID.
const TCGDEX_SET_MAP = {
  'sv1':  'sv01', 'sv2':  'sv02', 'sv3':  'sv03', 'sv3pt5': 'sv03.5',
  'sv4':  'sv04', 'sv4pt5': 'sv04.5', 'sv5':  'sv05', 'sv6':  'sv06',
  'sv6pt5': 'sv06.5', 'sv7':  'sv07', 'sv8':  'sv08', 'sv8pt5': 'sv08.5',
  'sv9':  'sv09', 'sv10': 'sv10',
  'svp':  'svp',  'mep':  'svp',  // TCGdex may lump promos together
  'me1':  'sv04.5', 'me2':  'sv05.5', 'me3': 'sv06.5', // speculative — will 404 gracefully
  'wht':  'sv10.5', 'bbt':  'sv10.5', // split expansion
};

// Sets where pokemontcg.io data is unreliable or missing.
// For these, skip pokemontcg.io entirely and go straight to TCGGO/JustTCG.
const POKEMONTCG_UNRELIABLE = new Set([
  'mep',    // Mega Evolution Promos — pokemontcg.io has completely wrong card names
  'me1',    // Mega Evolution — pokemontcg.io has completely wrong card names
  'me2pt5', // Ascended Heroes — very new
  'wht',    // White Flare — not indexed or incorrect
  'bbt',    // Black Bolt — not indexed or incorrect
]);
// Note: me2 (Phantasmal Flames) and me3 (Perfect Order) are CORRECT on pokemontcg.io.
// sv10 (Destined Rivals) removed — may be indexed correctly now.

// ── HARDCODED CORRECTIONS — verified against Pokellector.com ──
// pokemontcg.io maps me1/mep to the wrong sets entirely. These are the correct
// card lists from Pokellector, hardcoded so they're always right.
const POKELLECTOR_CORRECTIONS = {
  'me1': {
    setName: 'Mega Evolution', setCode: 'ME1',
    cards: {
      1:'Bulbasaur',2:'Ivysaur',3:'Mega Venusaur ex',4:'Exeggcute',5:'Exeggutor',
      6:'Tangela',7:'Tangrowth',8:'Chikorita',9:'Bayleef',10:'Meganium',
      11:'Shuckle',12:'Celebi',13:'Seedot',14:'Nuzleaf',15:'Shiftry',
      16:'Nincada',17:'Ninjask',18:'Dhelmise',19:'Vulpix',20:'Ninetales',
      21:'Numel',22:'Mega Camerupt ex',23:'Litleo',24:'Pyroar',25:'Volcanion',
      26:'Scorbunny',27:'Raboot',28:'Cinderace',29:'Sizzlipede',30:'Centiskorch',
      31:'Chi-Yu',32:'Mantine',33:'Corphish',34:'Kyogre',35:'Snover',
      36:'Mega Abomasnow ex',37:'Clauncher',38:'Clawitzer',39:'Sobble',40:'Drizzile',
      41:'Inteleon',42:'Snom',43:'Frosmoth',44:'Eiscue',45:'Magnemite',
      46:'Magneton',47:'Magnezone',48:'Raikou',49:'Electrike',50:'Mega Manectric ex',
      51:'Pachirisu',52:'Helioptile',53:'Heliolisk',54:'Abra',55:'Kadabra',
      56:'Alakazam',57:'Jynx',58:'Ralts',59:'Kirlia',60:'Mega Gardevoir ex',
      61:'Shedinja',62:'Spoink',63:'Grumpig',64:'Xerneas',65:'Greavard',
      66:'Houndstone',67:'Gimmighoul',68:'Sandshrew',69:'Sandslash',70:'Onix',
      71:'Tyrogue',72:'Makuhita',73:'Hariyama',74:'Lunatone',75:'Solrock',
      76:'Riolu',77:'Mega Lucario ex',78:'Croagunk',79:'Toxicroak',80:'Marshadow',
      81:'Stonjourner',82:'Nacli',83:'Naclstack',84:'Garganacl',85:'Crawdaunt',
      86:'Mega Absol ex',87:'Spiritomb',88:'Yveltal',89:'Nickit',90:'Thievul',
      91:'Shroodle',92:'Grafaiai',93:'Steelix',94:'Mega Mawile ex',95:'Dialga',
      96:'Tinkatink',97:'Tinkatuff',98:'Tinkaton',99:'Gholdengo',100:'Mega Latias ex',
      101:'Latios',102:'Spearow',103:'Fearow',104:'Mega Kangaskhan ex',105:'Delibird',
      106:'Miltank',107:'Buneary',108:'Lopunny',109:'Yungoos',110:'Gumshoos',
      111:'Stufful',112:'Bewear',113:"Acerola's Mischief",114:'Boss\'s Orders [Ghetsis]',
      115:'Energy Switch',116:'Fighting Gong',117:'Forest of Vitality',118:'Iron Defender',
      119:"Lillie's Determination",120:"Lt. Surge's Bargain",121:'Mega Signal',
      122:'Mystery Garden',123:'Pokémon Center Lady',124:'Premium Power Pro',
      125:'Rare Candy',126:'Repel',127:'Risky Ruins',128:'Strange Timepiece',
      129:'Surfing Beach',130:'Switch',131:'Ultra Ball',132:"Wally's Compassion",
      133:'Bulbasaur',134:'Ivysaur',135:'Exeggutor',136:'Shuckle',137:'Ninjask',
      138:'Vulpix',139:'Litleo',140:'Snover',141:'Clawitzer',142:'Inteleon',
      143:'Helioptile',144:'Shedinja',145:'Houndstone',146:'Marshadow',147:'Garganacl',
      148:'Spiritomb',149:'Shroodle',150:'Steelix',151:'Spearow',152:'Delibird',
      153:'Gumshoos',154:'Stufful',155:'Mega Venusaur ex',156:'Mega Camerupt ex',
      157:'Mega Abomasnow ex',158:'Mega Manectric ex',159:'Mega Gardevoir ex',
      160:'Mega Lucario ex',161:'Mega Absol ex',162:'Mega Mawile ex',
      163:'Mega Latias ex',164:'Mega Kangaskhan ex',165:"Acerola's Mischief",
      166:'Air Balloon',167:'Buddy-Buddy Poffin',168:'Fighting Gong',
      169:"Lillie's Determination",170:"Lt. Surge's Bargain",171:'Mega Signal',
      172:'Mystery Garden',173:'Night Stretcher',174:'Premium Power Pro',
      175:'Rare Candy',176:"Wally's Compassion",177:'Mega Venusaur ex',
      178:'Mega Gardevoir ex',179:'Mega Lucario ex',180:'Mega Absol ex',
      181:'Mega Latias ex',182:'Mega Kangaskhan ex',183:"Acerola's Mischief",
      184:"Lillie's Determination",185:"Lt. Surge's Bargain",186:"Wally's Compassion",
      187:'Mega Gardevoir ex',188:'Mega Lucario ex',
    }
  },
  'mep': {
    setName: 'Mega Evolution Promos', setCode: 'MEP',
    cards: {
      1:'Meganium',2:'Inteleon',3:'Alakazam',4:'Lunatone',5:'Drifloon',
      6:'Drifblim',7:'Psyduck',8:'Golduck',9:'Alakazam',10:'Riolu',
      11:'Mega Latias ex',12:'Mega Lucario ex',13:'Mega Venusaur ex',14:'Ceruledge',
      15:'Zacian',16:'Flygon',17:'Toxtricity',18:'Cottonee',19:'Whimsicott',
      20:'Sneasel',21:'Weavile',22:'Charcadet',23:'Mega Charizard ex',24:'Oricorio ex',
      25:'Mega Kangaskhan ex',26:'Meloetta',27:'Haunter',28:'Celebratory Fanfare',
      31:"N's Zekrom",32:'Mega Gardevoir ex',33:'Mega Lucario ex',
      36:'Mega Feraligatr ex',64:'Serperior',65:'Barbaracle',66:'Tyrantrum',
      67:'Doublade',69:'Chikorita',70:'Tyrunt',71:'Mega Zygarde ex',
      74:'Delphox',75:'Ampharos',76:'Crobat',77:'Goodra',78:'Toxel',79:'Charmeleon',
    }
  },
};

// ============================================================
// LOCAL CARD DATABASE — Google Sheet + JSON file + in-memory Map
// ============================================================
// On startup:
//   1. Try loading from Google Sheet CSV (if CARD_DB_SHEET_URL is set)
//   2. If no sheet or sheet fails, try data/card-db.json
//   3. If neither, download from pokemontcg.io in background
//   4. After any successful load, save to data/card-db.json as backup
//
// Google Sheet columns: set_id, number, name, set_name, set_code, rarity, hp
// Publish the sheet: File → Share → Publish to web → CSV
// Set env var: CARD_DB_SHEET_URL=https://docs.google.com/spreadsheets/d/.../export?format=csv
//
// The sheet is the editable source of truth — fix card names there.
// Key format: "{setId}-{number}" e.g. "sv8-247", "me2-101"

const CARD_DB_FILE = join(__dirname, 'data', 'card-db.json');
const CARD_DB = new Map();
let cardDbReady = false;
let cardDbCount = 0;
let cardDbLoading = false;
let cardDbDirty = false;   // true if we have new entries not yet saved

// Apply hardcoded Pokellector corrections — overwrites any bad data for me1/mep
function applyPokellectorCorrections() {
  let count = 0;
  for (const [setId, setData] of Object.entries(POKELLECTOR_CORRECTIONS)) {
    for (const [num, name] of Object.entries(setData.cards)) {
      addCardToDb(setId, String(num), {
        name,
        setName: setData.setName,
        setCode: setData.setCode,
        rarity: '',
        hp: '',
        source: 'pokellector',  // highest trust — verified manually
      });
      count++;
    }
  }
  console.log(`[CARD-DB] Applied ${count} Pokellector corrections (me1: ${Object.keys(POKELLECTOR_CORRECTIONS.me1.cards).length}, mep: ${Object.keys(POKELLECTOR_CORRECTIONS.mep.cards).length})`);
  cardDbDirty = true;
}

function addCardToDb(setId, number, data) {
  const key = `${setId}-${number}`;
  const existing = CARD_DB.get(key);
  // Pokellector data is highest trust — never overwrite it
  if (existing && existing.source === 'pokellector' && data.source !== 'pokellector') {
    return;
  }
  // Don't overwrite trusted sources with sheet data
  if (existing && data.source === 'sheet' &&
      (existing.source === 'fallback' || existing.source === 'tcggo' || existing.source === 'manual')) {
    return;
  }
  CARD_DB.set(key, data);
}

function lookupLocalDb(setId, cardNumber) {
  const cleanNum = String(cardNumber).replace(/^0+/, '') || String(cardNumber);
  const key = `${setId}-${cleanNum}`;
  const entry = CARD_DB.get(key);
  if (entry) {
    // For UNRELIABLE sets, only trust pokellector/tcggo/fallback/manual entries
    if (POKEMONTCG_UNRELIABLE.has(setId)) {
      const trusted = entry.source === 'pokellector' || entry.source === 'tcggo' || entry.source === 'fallback' || entry.source === 'manual';
      if (!trusted) {
        console.log(`[LOCAL-DB] SKIP untrusted entry: ${key} → ${entry.name} (source: ${entry.source || 'none'})`);
        return null;
      }
    }
    console.log(`[LOCAL-DB] HIT: ${key} → ${entry.name} (source: ${entry.source || 'unknown'})`);
    return {
      game: 'pokemon',
      name: entry.name,
      set_name: entry.setName,
      set_code: (entry.setCode || setId).toUpperCase(),
      card_number: cleanNum,
      rarity: entry.rarity || '',
      hp: entry.hp || '',
      reference_image: entry.image || null,
      cardmarket_url: entry.cardmarketUrl || null,
      tcgplayer_url: entry.tcgplayerUrl || null,
      verified: true,
      db_source: 'local-db',
      _manual: true
    };
  }
  return null;
}

// ── SAVE to JSON file ──
function saveCardDbToFile() {
  try {
    const dataDir = join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    // Convert Map to plain object for JSON
    const obj = {};
    for (const [key, val] of CARD_DB) {
      obj[key] = val;
    }
    fs.writeFileSync(CARD_DB_FILE, JSON.stringify(obj));
    const sizeMB = (fs.statSync(CARD_DB_FILE).size / 1024 / 1024).toFixed(1);
    console.log(`[CARD-DB] Saved ${CARD_DB.size} cards to ${CARD_DB_FILE} (${sizeMB} MB)`);
    cardDbDirty = false;
  } catch (e) {
    console.error(`[CARD-DB] Failed to save: ${e.message}`);
  }
}

// ── LOAD from JSON file ──
function loadCardDbFromFile() {
  try {
    if (!fs.existsSync(CARD_DB_FILE)) return false;
    const raw = fs.readFileSync(CARD_DB_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const keys = Object.keys(obj);
    if (keys.length === 0) return false;

    for (const key of keys) {
      CARD_DB.set(key, obj[key]);
    }
    cardDbCount = CARD_DB.size;
    cardDbReady = true;
    const sizeMB = (fs.statSync(CARD_DB_FILE).size / 1024 / 1024).toFixed(1);
    console.log(`[CARD-DB] Loaded ${cardDbCount} cards from file (${sizeMB} MB)`);
    return true;
  } catch (e) {
    console.error(`[CARD-DB] Failed to load file: ${e.message}`);
    return false;
  }
}

// ── DOWNLOAD from pokemontcg.io (only if no local file) ──
async function downloadCardDatabase() {
  if (cardDbLoading) return;
  cardDbLoading = true;
  const PAGE_SIZE = 250;

  try {
    console.log('[CARD-DB] No local file — downloading from pokemontcg.io...');
    const firstResp = await axios.get('https://api.pokemontcg.io/v2/cards', {
      params: { pageSize: PAGE_SIZE, page: 1, select: 'id,name,number,rarity,set,hp,supertype,subtypes,cardmarket,tcgplayer,images' },
      timeout: 30000
    });
    const totalCount = firstResp.data?.totalCount || 0;
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    console.log(`[CARD-DB] Total: ${totalCount} cards across ${totalPages} pages`);

    processPageData(firstResp.data?.data || []);
    console.log(`[CARD-DB] Page 1/${totalPages} (${CARD_DB.size} cards)`);

    const BATCH = 3;
    for (let start = 2; start <= totalPages; start += BATCH) {
      const pages = [];
      for (let p = start; p < start + BATCH && p <= totalPages; p++) {
        pages.push(
          axios.get('https://api.pokemontcg.io/v2/cards', {
            params: { pageSize: PAGE_SIZE, page: p, select: 'id,name,number,rarity,set,hp,supertype,subtypes,cardmarket,tcgplayer,images' },
            timeout: 30000
          }).then(r => {
            processPageData(r.data?.data || []);
            return p;
          }).catch(e => {
            console.log(`[CARD-DB] Page ${p} failed: ${e.message}`);
            return null;
          })
        );
      }
      const done = await Promise.all(pages);
      const maxPage = Math.max(...done.filter(Boolean));
      if (maxPage % 10 === 0 || maxPage === totalPages) {
        console.log(`[CARD-DB] Progress: page ${maxPage}/${totalPages} (${CARD_DB.size} cards)`);
      }
    }

    cardDbCount = CARD_DB.size;
    cardDbReady = true;
    console.log(`[CARD-DB] Download complete! ${cardDbCount} cards.`);

    // Save to file so next restart is instant
    saveCardDbToFile();
  } catch (e) {
    console.error(`[CARD-DB] Download failed: ${e.message}`);
    if (CARD_DB.size > 0) {
      cardDbCount = CARD_DB.size;
      cardDbReady = true;
      console.log(`[CARD-DB] Partial: ${cardDbCount} cards available`);
      saveCardDbToFile();
    }
  }
  cardDbLoading = false;
}

function processPageData(cards) {
  for (const c of cards) {
    const setId = c.set?.id || '';
    const num = c.number || '';
    if (!setId || !num) continue;
    if (POKEMONTCG_UNRELIABLE.has(setId)) continue;

    addCardToDb(setId, num, {
      name: c.name,
      setName: c.set?.name || '',
      setCode: (c.set?.ptcgoCode || setId).toUpperCase(),
      rarity: c.rarity || '',
      hp: c.hp || '',
      supertype: c.supertype || '',
      subtypes: c.subtypes || [],
      image: c.images?.large || c.images?.small || '',
      cardmarketUrl: c.cardmarket?.url || null,
      tcgplayerUrl: c.tcgplayer?.url || null,
      source: 'pokemontcg',
    });
  }
}

// Cache cards from successful fallback lookups so repeat scans are instant
function cacheCardResult(setId, cardNumber, cardData) {
  if (!setId || !cardNumber) return;
  const cleanNum = String(cardNumber).replace(/^0+/, '') || String(cardNumber);
  addCardToDb(setId, cleanNum, {
    name: cardData.name,
    setName: cardData.set_name || '',
    setCode: cardData.set_code || setId.toUpperCase(),
    rarity: cardData.rarity || '',
    hp: cardData.hp || '',
    image: cardData.reference_image || '',
    cardmarketUrl: cardData.cardmarket_url || null,
    tcgplayerUrl: cardData.tcgplayer_url || null,
    source: 'fallback',
  });
  cardDbDirty = true;
  console.log(`[LOCAL-DB] Cached: ${setId}-${cleanNum} → ${cardData.name}`);
}

// Periodically save dirty cache (every 5 min if new entries were added)
setInterval(() => {
  if (cardDbDirty && CARD_DB.size > 0) {
    saveCardDbToFile();
  }
}, 5 * 60 * 1000);

// Status endpoint
app.get('/api/card-db-status', (req, res) => {
  res.json({
    ready: cardDbReady,
    loading: cardDbLoading,
    count: CARD_DB.size,
    fileExists: fs.existsSync(CARD_DB_FILE),
  });
});

// ── LOAD from Google Sheet CSV ──
async function loadCardDbFromSheet() {
  const sheetUrl = process.env.CARD_DB_SHEET_URL;
  if (!sheetUrl) return false;

  try {
    console.log('[CARD-DB] Fetching Google Sheet CSV...');
    const resp = await axios.get(sheetUrl, { timeout: 30000, responseType: 'text' });
    const csv = resp.data;
    if (!csv || csv.length < 50) {
      console.log('[CARD-DB] Sheet is empty or too small');
      return false;
    }

    // Parse CSV — columns: set_id, number, name, set_name, set_code, rarity, hp
    const lines = csv.split('\n');
    const header = lines[0].toLowerCase();
    if (!header.includes('set_id') && !header.includes('name')) {
      console.log('[CARD-DB] Sheet missing expected headers');
      return false;
    }

    let loaded = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Simple CSV parse (handles quoted fields with commas)
      const cols = parseCSVLine(line);
      if (cols.length < 3) continue;

      const setId = (cols[0] || '').trim();
      const num = (cols[1] || '').trim();
      const name = (cols[2] || '').trim();
      if (!setId || !num || !name) continue;

      // Check for "verified" column (col 7) — if present and truthy,
      // trust this entry even for UNRELIABLE sets (Dave manually fixed it)
      const verified = (cols[7] || '').trim().toLowerCase();
      const isVerified = verified === 'yes' || verified === 'true' || verified === '1';

      addCardToDb(setId, num, {
        name: name,
        setName: (cols[3] || '').trim(),
        setCode: (cols[4] || setId).trim().toUpperCase(),
        rarity: (cols[5] || '').trim(),
        hp: (cols[6] || '').trim(),
        source: isVerified ? 'manual' : 'sheet',
      });
      loaded++;
    }

    if (loaded > 0) {
      cardDbCount = CARD_DB.size;
      cardDbReady = true;
      console.log(`[CARD-DB] Loaded ${loaded} cards from Google Sheet`);
      // Save to JSON file as backup
      saveCardDbToFile();
      return true;
    }
    return false;
  } catch (e) {
    console.error(`[CARD-DB] Google Sheet fetch failed: ${e.message}`);
    return false;
  }
}

// Simple CSV line parser that handles quoted fields
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// Export current DB as CSV — use this to populate the Google Sheet
app.get('/api/card-db-export', (req, res) => {
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

// Manual rebuild endpoint — re-download from pokemontcg.io
app.post('/api/card-db-rebuild', (req, res) => {
  if (cardDbLoading) return res.json({ status: 'already loading', count: CARD_DB.size });
  CARD_DB.clear();
  cardDbReady = false;
  downloadCardDatabase();
  res.json({ status: 'rebuild started' });
});

// ── BULK IMPORT: fetch all cards for UNRELIABLE sets from TCGGO ──
// Runs once after main DB loads. Replaces bad pokemontcg.io data with correct
// TCGGO data so scanning is instant local lookups with zero per-scan API calls.
let unreliableImportDone = false;
async function importUnreliableSetsFromTCGGO() {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    console.log('[TCGGO-IMPORT] No RAPIDAPI_KEY — skipping unreliable set import');
    return;
  }
  if (unreliableImportDone) return;

  const setsToImport = [...POKEMONTCG_UNRELIABLE]
    .filter(s => PKM_SET_NAMES[s]); // only sets we have names for

  console.log(`[TCGGO-IMPORT] Importing ${setsToImport.length} unreliable sets: ${setsToImport.join(', ')}`);
  let totalImported = 0;

  for (const setId of setsToImport) {
    const setName = PKM_SET_NAMES[setId];
    let page = 1;
    let setCount = 0;
    let hasMore = true;

    while (hasMore) {
      try {
        const resp = await axios.get('https://pokemon-tcg-api.p.rapidapi.com/cards/search', {
          params: { search: setName, per_page: 50, page },
          headers: {
            'X-RapidAPI-Key': apiKey,
            'X-RapidAPI-Host': 'pokemon-tcg-api.p.rapidapi.com',
            'Accept': 'application/json'
          },
          timeout: 15000
        });

        const data = resp.data?.data;
        if (!data || data.length === 0) {
          hasMore = false;
          break;
        }

        for (const card of data) {
          // Only keep cards whose episode/set name matches what we searched for
          const epName = (card.episode?.name || '').toLowerCase();
          const epCode = (card.episode?.code || '').toUpperCase();
          if (!epName.includes(setName.toLowerCase()) && epCode !== setId.toUpperCase()) continue;

          const num = String(card.card_number || '').replace(/^0+/, '');
          if (!num) continue;

          addCardToDb(setId, num, {
            name: card.name,
            setName: card.episode?.name || setName,
            setCode: (card.episode?.code || setId).toUpperCase(),
            rarity: card.rarity || '',
            hp: '',
            image: card.image || '',
            source: 'tcggo',  // trusted — won't be skipped for UNRELIABLE sets
          });
          setCount++;
        }

        // If fewer results than per_page, we've hit the last page
        if (data.length < 50) {
          hasMore = false;
        } else {
          page++;
          // Small delay to avoid rate limiting
          await new Promise(r => setTimeout(r, 300));
        }
      } catch (e) {
        if (e.response?.status === 429) {
          console.log(`[TCGGO-IMPORT] Rate limited on ${setName} page ${page} — pausing 5s`);
          await new Promise(r => setTimeout(r, 5000));
          continue; // retry same page
        }
        console.log(`[TCGGO-IMPORT] Error on ${setName} page ${page}: ${e.response?.status || e.message}`);
        hasMore = false;
      }
    }

    console.log(`[TCGGO-IMPORT] ${setName} (${setId}): ${setCount} cards imported`);
    totalImported += setCount;

    // Small delay between sets
    await new Promise(r => setTimeout(r, 500));
  }

  if (totalImported > 0) {
    cardDbDirty = true;
    cardDbCount = CARD_DB.size;
    console.log(`[TCGGO-IMPORT] Done — imported ${totalImported} cards across ${setsToImport.length} sets (DB total: ${CARD_DB.size})`);
    saveCardDbToFile();
  }
  unreliableImportDone = true;
}

// Manual trigger endpoint
app.post('/api/card-db-import-unreliable', (req, res) => {
  unreliableImportDone = false; // allow re-run
  importUnreliableSetsFromTCGGO();
  res.json({ status: 'import started', sets: [...POKEMONTCG_UNRELIABLE].filter(s => PKM_SET_NAMES[s]) });
});

// ── STARTUP: Google Sheet → JSON file → API download → apply corrections ──
async function initCardDb() {
  // 1. Google Sheet (editable source of truth)
  const fromSheet = await loadCardDbFromSheet();
  if (!fromSheet) {
    // 2. Local JSON file (fast backup)
    const fromFile = loadCardDbFromFile();
    if (!fromFile) {
      // 3. Download from pokemontcg.io (slow but self-healing)
      await downloadCardDatabase();
    }
  }

  // 4. ALWAYS apply Pokellector corrections — overwrites any wrong me1/mep data
  //    regardless of where it came from. These are hardcoded and verified.
  applyPokellectorCorrections();
  saveCardDbToFile();
}
initCardDb();

// Resolve a user-typed set code to an API set.id
function resolveSetCode(raw) {
  if (!raw) return { setId: null, ptcgoCode: null, aliased: false };
  const upper = String(raw).toUpperCase().trim();
  const lower = String(raw).toLowerCase().trim();
  const mapped = PKM_SET_ALIASES[upper];
  if (mapped) {
    console.log(`[SET-ALIAS] "${upper}" -> set.id "${mapped}"`);
    return { setId: mapped, ptcgoCode: upper, aliased: true };
  }
  // No alias found — try as-is (might already be a valid set.id or ptcgoCode)
  return { setId: lower, ptcgoCode: upper, aliased: false };
}

// ============================================================
// FALLBACK: TCGdex card lookup (free, open-source Pokemon TCG database)
// ============================================================
async function lookupTCGdex(setId, cardNumber) {
  // Map our internal set.id to TCGdex's set ID format
  const tcgdexSetId = TCGDEX_SET_MAP[setId] || setId;
  const cleanNum = String(cardNumber).replace(/\/.*/, '').replace(/^0+/, '') || String(cardNumber);
  const cardId = `${tcgdexSetId}-${cleanNum}`;
  console.log(`[TCGdex] Looking up: ${cardId}`);
  try {
    const resp = await axios.get(`https://api.tcgdex.net/v2/en/cards/${cardId}`, { timeout: 8000 });
    const d = resp.data;
    if (!d || !d.name) return null;
    console.log(`[TCGdex] Found: ${d.name} (${d.set?.name || '?'})`);
    return {
      game: 'pokemon',
      name: d.name,
      set_name: d.set?.name || null,
      set_code: (d.set?.id || setId).toUpperCase(),
      card_number: d.localId || cleanNum,
      rarity: d.rarity || null,
      hp: d.hp ? String(d.hp) : null,
      reference_image: d.image ? `${d.image}/high.webp` : null,
      verified: true,
      db_source: 'tcgdex.net (fallback)',
      _manual: true
    };
  } catch (e) {
    console.log(`[TCGdex] ${cardId} failed: ${e.response?.status || e.message}`);
    return null;
  }
}

// FALLBACK: TCGGO search by set name + card number
// Used when both pokemontcg.io and TCGdex don't have a set.
// Tries multiple search strategies for best results.
async function lookupViaTCGGO(setId, cardNumber, rawSetCode) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return null;

  const setName = PKM_SET_NAMES[setId];
  const cleanNum = String(cardNumber).replace(/\/.*/, '').replace(/^0+/, '') || String(cardNumber);
  const paddedNum = cleanNum.padStart(3, '0');

  // Try multiple search terms — promo sets need different strategies
  const searchTerms = [];
  // 1. Raw set code + padded number (e.g. "MEP 026") — how it appears on the card
  if (rawSetCode) searchTerms.push(`${rawSetCode} ${paddedNum}`);
  // 2. Set name + number (e.g. "Mega Evolution Promos 26")
  if (setName) searchTerms.push(`${setName} ${cleanNum}`);
  // 3. Set name + padded number
  if (setName) searchTerms.push(`${setName} ${paddedNum}`);
  // 4. Raw code without number, broader search
  if (rawSetCode) searchTerms.push(`${rawSetCode} promo ${cleanNum}`);

  if (!searchTerms.length) {
    console.log(`[TCGGO-FALLBACK] No search terms for "${setId}" — skipping`);
    return null;
  }

  for (const searchTerm of searchTerms) {
    console.log(`[TCGGO-FALLBACK] Searching: "${searchTerm}"`);
    try {
      const resp = await axios.get('https://pokemon-tcg-api.p.rapidapi.com/cards/search', {
        params: { search: searchTerm, per_page: 10 },
        headers: {
          'X-RapidAPI-Key': apiKey,
          'X-RapidAPI-Host': 'pokemon-tcg-api.p.rapidapi.com',
          'Accept': 'application/json'
        },
        timeout: 10000
      });

      const data = resp.data?.data;
      if (!data || data.length === 0) continue;

      // Score results — card number match is REQUIRED, set match is bonus
      let best = null;
      let bestScore = 0;
      for (const item of data) {
        const itemNum = String(item.card_number || '');
        // Card number MUST match — skip items that don't
        if (itemNum !== cleanNum && itemNum !== paddedNum && itemNum !== cardNumber) continue;

        let score = 60; // base score for number match
        const epName = (item.episode?.name || '').toLowerCase();
        const epCode = (item.episode?.code || '').toUpperCase();
        // Set name/code match
        if (setName && epName.includes(setName.toLowerCase())) score += 40;
        if (rawSetCode && epCode === rawSetCode.toUpperCase()) score += 50;
        // Prefer promo matches for promo sets
        if (setId.endsWith('p') || setId === 'mep') {
          if (epName.includes('promo')) score += 20;
        }
        if (score > bestScore) { bestScore = score; best = item; }
      }

      if (best) {
        console.log(`[TCGGO-FALLBACK] Found: ${best.name} (${best.episode?.name || '?'} #${best.card_number}) [score ${bestScore}]`);
        return {
          game: 'pokemon',
          name: best.name,
          set_name: best.episode?.name || setName || rawSetCode,
          set_code: (best.episode?.code || rawSetCode || setId).toUpperCase(),
          card_number: String(best.card_number || cleanNum),
          rarity: best.rarity || null,
          reference_image: best.image || null,
          verified: true,
          db_source: 'tcggo.com (fallback)',
          _manual: true
        };
      }
    } catch (e) {
      if (e.response?.status === 429) {
        console.log('[TCGGO-FALLBACK] Rate limited — stopping');
        return null;
      }
      console.log(`[TCGGO-FALLBACK] Error: ${e.response?.status || e.message}`);
    }
  }

  console.log(`[TCGGO-FALLBACK] No match after all search strategies for ${rawSetCode || setId} #${cleanNum}`);
  return null;
}

// FALLBACK: JustTCG search by set name + card number
async function lookupViaJustTCG(setId, cardNumber) {
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return null;

  const setName = PKM_SET_NAMES[setId];
  if (!setName) return null;

  const cleanNum = String(cardNumber).replace(/\/.*/, '').replace(/^0+/, '') || String(cardNumber);
  const searchQuery = `${setName} ${cleanNum}`;
  console.log(`[JustTCG-FALLBACK] Searching: "${searchQuery}"`);

  try {
    const resp = await axios.get('https://api.justtcg.com/v1/cards', {
      params: { q: searchQuery, game: 'pokemon', limit: 5 },
      headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
      timeout: 10000
    });

    const data = resp.data?.data;
    if (!data || data.length === 0) {
      console.log('[JustTCG-FALLBACK] No results');
      return null;
    }

    // Find best match by card number
    let best = data[0];
    let bestScore = 0;
    for (const item of data) {
      let score = 0;
      const itemNum = (item.number || '').replace(/\/.*/, '');
      if (itemNum === cleanNum) score += 60;
      if (item.set_name?.toLowerCase().includes(setName.toLowerCase())) score += 40;
      if (score > bestScore) { bestScore = score; best = item; }
    }

    console.log(`[JustTCG-FALLBACK] Found: ${best.name} (${best.set_name || '?'} #${best.number})`);
    return {
      game: 'pokemon',
      name: best.name,
      set_name: best.set_name || setName,
      set_code: setId.toUpperCase(),
      card_number: best.number || cleanNum,
      rarity: best.rarity || null,
      reference_image: best.image_url || null,
      verified: true,
      db_source: 'justtcg.com (fallback)',
      _manual: true
    };
  } catch (e) {
    console.log(`[JustTCG-FALLBACK] Error: ${e.response?.status || e.message}`);
    return null;
  }
}

// ============================================================
// MANUAL IDENTIFY: /api/identify-manual
// ============================================================
// Skip Claude entirely — operator types in set code + card number (+ optional name)
// and we resolve it against the relevant card database directly.
// Use when scans are failing (sleeves, glare, damaged cards) and speed matters.
//
// Request body: { game: 'pokemon'|'magic'|..., set_code, card_number, name? }
// Response: { cards: [<one card shaped like /api/identify output>] }
app.post('/api/identify-manual', async (req, res) => {
  try {
    const { game, set_code, card_number, name } = req.body || {};
    if (!game) return res.status(400).json({ error: 'game is required' });
    if (!card_number) return res.status(400).json({ error: 'card_number is required' });

    const cleanNum = String(card_number).replace(/\/.*/, '').replace(/^0+/, '') || String(card_number);
    let card = null;

    if (game === 'pokemon') {
      // Resolve aliases first (e.g. PAL -> sv2, OBF -> sv3, MEW -> sv3pt5)
      const resolved = set_code ? resolveSetCode(set_code) : { setId: null, ptcgoCode: null };

      // ── LOCAL DB CHECK (instant, no API call) ──
      if (resolved.setId) {
        card = lookupLocalDb(resolved.setId, cleanNum);
        if (card) {
          console.log(`[MANUAL-PKM] Local DB hit: ${card.name} (${resolved.setId}-${cleanNum})`);
          return res.json({ cards: [card] });
        }
      }

      // Try set-code-scoped search first, then fall back to number-only.
      const queries = [];
      if (resolved.setId) {
        queries.push(`set.id:${resolved.setId} number:${cleanNum}`);
      }
      // Only try ptcgoCode search if we did NOT resolve via our alias table.
      // Reason: ptcgoCodes can be reused/reassigned (e.g. PRE = Journey Together
      // in the API, but our alias correctly maps PRE -> sv8pt5 Prismatic Evolutions).
      // Using ptcgoCode after a known alias would return the WRONG set.
      if (resolved.ptcgoCode && !resolved.aliased) {
        queries.push(`set.ptcgoCode:${resolved.ptcgoCode} number:${cleanNum}`);
      }
      // Also try the raw input in case it's already a valid set.id we don't have aliased
      if (set_code && !resolved.aliased && resolved.setId !== String(set_code).toLowerCase()) {
        queries.push(`set.id:${String(set_code).toLowerCase()} number:${cleanNum}`);
      }
      if (name) queries.push(`name:"${name}" number:${cleanNum}`);
      // Only fall back to bare number search if a name was given (to avoid
      // random matches like Primal Groudon #151 when user meant MEW 151).
      if (name) queries.push(`number:${cleanNum} name:"${name}"`);

      // Skip pokemontcg.io entirely for sets with known bad data.
      // Go straight to TCGGO/JustTCG fallback chain instead.
      const skipPokemonTCG = resolved.setId && POKEMONTCG_UNRELIABLE.has(resolved.setId);
      if (skipPokemonTCG) {
        console.log(`[MANUAL-PKM] Skipping pokemontcg.io for unreliable set "${resolved.setId}" — going to fallbacks`);
      }

      // Also try direct card ID lookup: pokemontcg.io stores cards as {setId}-{number}
      // e.g. sv3pt5-151. This is the fastest and most reliable approach.
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

      // If direct lookup didn't work, fall back to search queries.
      if (!card && !skipPokemonTCG) {
        for (const q of queries) {
          console.log(`[MANUAL-PKM] Trying: ${q}`);
          try {
            const resp = await axios.get('https://api.pokemontcg.io/v2/cards', {
              params: { q, pageSize: 10 }, timeout: 10000
            });
            const results = resp.data?.data;
            if (!results?.length) continue;
            // If we have a name, prefer an exact-name match.
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

      // ── FALLBACK CHAIN when pokemontcg.io doesn't have the set ──
      if (!card && resolved.setId) {
        console.log(`[MANUAL-PKM] pokemontcg.io miss — trying fallback APIs for ${resolved.setId} #${cleanNum}`);

        // Fallback 1: TCGdex (free card database)
        card = await lookupTCGdex(resolved.setId, cleanNum);

        // Fallback 2: TCGGO via RapidAPI (search by set name + number)
        if (!card) {
          card = await lookupViaTCGGO(resolved.setId, cleanNum, set_code);
        }

        // Fallback 3: JustTCG (search by set name + number)
        if (!card) {
          card = await lookupViaJustTCG(resolved.setId, cleanNum);
        }

        if (card) {
          console.log(`[MANUAL-PKM] Fallback success: ${card.name} via ${card.db_source}`);
        } else {
          console.log(`[MANUAL-PKM] All fallbacks exhausted for ${set_code} #${cleanNum}`);
        }
      }
    } else if (game === 'magic') {
      // Scryfall supports direct set+collector number lookup.
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
      // Name-based fallback
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
      // Generic / fallback: just build a shell card from the inputs so pricing can still try.
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

    // Cache successful lookups in local DB for instant future hits
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

// ============================================================
// READ SET CODE: /api/read-set-code
// ============================================================
// Lightweight Claude Vision call — reads ONLY the set code + card number
// from the bottom of a card image.  Much cheaper than full identify because
// the prompt is tiny, the response is a few tokens, and we use Haiku.
// Returns: { text: "MEP 066" } or { text: "DRI 204/182" } or { error }
app.post('/api/read-set-code', identifyLimiter, async (req, res) => {
  try {
    const dataUrl = req.body?.image;
    if (!dataUrl) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const match = dataUrl.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid image data URL' });
    }

    // Pass image through with minimal processing — JPEG 0.98 from client.
    // Only downscale if over 4MB (Claude's limit), otherwise send as-is.
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

    console.log('[READ-SET-CODE] Sending to Claude Haiku...');
    const t0 = Date.now();

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
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

    // Post-process: strip markdown bold, extract code from verbose response
    raw = raw.replace(/\*\*/g, '').replace(/^#+\s*/, '');
    // If Haiku gave a verbose response, try to extract a code from it
    if (raw.length > 30) {
      // Look for patterns like "DRI 244/182" or "SWSH020" or "GG31/GG70" in the text
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
    // Fix common Haiku merge: "PFLEN" → "PFL", "DRIEN" → "DRI"
    raw = raw.replace(/^([A-Z]{2,4})(EN)\s/, '$1 ');

    // ── SET TOTAL VALIDATION ──
    // If Haiku read "MEP 151/132" but MEP has no /132, the set code is wrong.
    // Use the total to correct misreads like MEP→MEG, WHT→POR, etc.
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
        // Total doesn't match — find which set DOES have this total
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

// ============================================================
// BAD-ID FEEDBACK: /api/report-bad-id
// ============================================================
// Append a JSONL line to logs/bad-ids.log with the card + reason the user
// flagged. Useful to spot systematic ID failures (e.g. "always mis-IDs
// reverse-holo Pikachus from Evolving Skies") without needing a DB.
app.post('/api/report-bad-id', express.json({ limit: '15mb' }), async (req, res) => {
  try {
    const { card, reason, image, timestamp, ua } = req.body || {};
    const logDir = join(__dirname, 'logs');
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

// ============================================================
// CORRECT CARD: /api/correct-card
// ============================================================
// User taps a wrong card name and types the correct one.
// Overwrites the entry in the local DB with source 'manual' (highest trust).
// Persists through restarts via the JSON file.
app.post('/api/correct-card', express.json(), (req, res) => {
  try {
    const { set_code, card_number, correct_name } = req.body || {};
    if (!set_code || !card_number || !correct_name) {
      return res.status(400).json({ error: 'set_code, card_number, and correct_name required' });
    }

    const resolved = resolveSetCode(set_code);
    const setId = resolved.setId || set_code.toLowerCase();
    const cleanNum = String(card_number).replace(/\/.*/, '').replace(/^0+/, '') || String(card_number);

    // Get existing entry to preserve metadata, or create fresh
    const key = `${setId}-${cleanNum}`;
    const existing = CARD_DB.get(key) || {};

    // Overwrite with manual correction — force source to 'manual'
    CARD_DB.set(key, {
      ...existing,
      name: correct_name.trim(),
      setName: existing.setName || PKM_SET_NAMES[setId] || set_code,
      setCode: (existing.setCode || set_code).toUpperCase(),
      source: 'manual',  // highest trust, never overwritten
    });

    cardDbDirty = true;
    cardDbCount = CARD_DB.size;
    saveCardDbToFile();

    console.log(`[CORRECT] ${key}: "${existing.name || '?'}" → "${correct_name.trim()}" (manual override)`);
    res.json({ ok: true, key, oldName: existing.name || null, newName: correct_name.trim() });
  } catch (err) {
    console.error('[CORRECT] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// OCR-FIRST LOOKUP: /api/lookup-by-number
// ============================================================
// The client runs Tesseract.js locally, parses the card number, and hits
// this endpoint. If we can pinpoint exactly one card from the number alone,
// we skip Claude entirely (~300ms vs ~2.5s). If not, the client falls back
// to /api/identify.
//
// Body: { number: "123/456", setCode?: "swsh9", game?: "pokemon"|"magic" }
// Returns: { cards: [verifiedCard] } on match, or 404 on no-match/ambiguous.
app.post('/api/lookup-by-number', express.json(), async (req, res) => {
  try {
    const { number, set_code: setCode, game, reg_mark } = req.body || {};
    if (!number || typeof number !== 'string') {
      return res.status(400).json({ error: 'number required' });
    }

    const raw = number.trim();

    // Regulation mark → era mapping (helps disambiguate when multiple sets match)
    const REG_MARK_ERAS = {
      'D': { minYear: 2019, maxYear: 2021, prefix: 'swsh' },
      'E': { minYear: 2021, maxYear: 2023, prefix: 'swsh' },
      'F': { minYear: 2022, maxYear: 2024, prefix: 'swsh' },
      'G': { minYear: 2023, maxYear: 2025, prefix: 'sv' },
      'H': { minYear: 2024, maxYear: 2026, prefix: 'sv' },
      'J': { minYear: 2025, maxYear: 2027, prefix: '' },  // ME era
    };

    // Try Scryfall first if we have an explicit setCode (Magic).
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

    // Pokemon TCG lookup — handles both "123/456" and promo formats like SM211.
    // We search by number, optionally narrowing by printedTotal from "xx/yy" form.
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
            // Multiple matches — use regulation mark to pick the right era
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


// ============================================================
// PRE-VERIFY: Fix common AI suffix mistakes using HP ranges
// ============================================================
// The AI frequently confuses "ex" (lowercase, SV era, 300+ HP) with "GX" (SM era, 200-270 HP)
// HP ranges by Pokemon card type:
//   Regular:    30-200 HP
//   EX (XY):    160-230 HP
//   GX (SM):    170-270 HP
//   V (SWSH):   180-230 HP
//   VMAX:       300-340 HP
//   VSTAR:      250-280 HP
//   ex (SV):    250-340 HP  (lowercase!)
function fixPokemonSuffix(card) {
  if (card.game !== 'pokemon') return card;

  const hp = parseInt(card.hp);
  const name = card.name || '';
  const suffix = extractPokemonSuffix(name);

  if (!hp || !suffix) return card;

  let correctedSuffix = suffix;
  let reason = '';

  // GX cards NEVER have 340+ HP — if AI says GX with 340+ HP, it's very likely "ex"
  // NOTE: Raised threshold from 300 to 340 because the AI sometimes misreads HP from images
  // (e.g. reads 330 when card says 250). GX can go up to ~270HP, so 340+ is a safer cutoff.
  // We'd rather keep a correct GX than wrongly flip it to ex based on a misread HP.
  if (suffix === 'GX' && hp >= 340) {
    correctedSuffix = 'ex';
    reason = `HP ${hp} is too high for GX (max ~270). This is an "ex" card.`;
  }
  // "ex" cards in SV era are typically 250+ HP — if AI says "ex" with < 200 HP, might be wrong
  // But ex can have lower HP for basic Pokemon, so only flag very low
  if (suffix === 'ex' && hp <= 150) {
    // Low HP ex is unusual but possible for basic ex — just log it
    console.log(`[FIX-SUFFIX] Warning: "${name}" has low HP ${hp} for an ex card`);
  }
  // V cards are 180-230 HP, if AI says V with 300+ HP it's probably VMAX
  if (suffix === 'V' && hp >= 300) {
    correctedSuffix = 'VMAX';
    reason = `HP ${hp} is too high for V (max ~230). This is likely VMAX.`;
  }
  // VMAX should be 300+ HP
  if (suffix === 'VMAX' && hp < 280) {
    correctedSuffix = 'V';
    reason = `HP ${hp} is too low for VMAX (min ~300). This is likely V.`;
  }

  if (correctedSuffix !== suffix) {
    const baseName = name.replace(/\s*(ex|GX|EX|V|VMAX|VSTAR|LV\.X)\s*$/, '').trim();
    const newName = `${baseName} ${correctedSuffix}`;
    console.log(`[FIX-SUFFIX] CORRECTED: "${name}" -> "${newName}" (${reason})`);
    return { ...card, name: newName, original_ai_name: name };
  }

  return card;
}


// ============================================================
// CARD VERIFICATION — Cross-reference AI results with real databases
// ============================================================
// After the AI identifies a card, we look it up in the correct game
// database to verify/correct set name, set code, card number, and
// get a reference image. This fixes the "wrong set" problem.

async function verifyCard(card) {
  console.log(`[VERIFY] ${card.game}: "${card.name}" (AI says: ${card.set_name} #${card.card_number})`);

  try {
    let verified = null;

    switch (card.game) {
      case 'starwars':
        verified = await verifySWU(card);
        break;
      case 'magic':
        verified = await verifyMagic(card);
        break;
      case 'pokemon':
        verified = await verifyPokemon(card);
        break;
      case 'yugioh':
        verified = await verifyYuGiOh(card);
        break;
      case 'onepiece':
      case 'lorcana':
      case 'digimon':
      case 'fleshandblood':
      case 'dragonball':
        // For these games, try a generic name search
        verified = await verifyGeneric(card);
        break;
    }

    if (verified) {
      // POST-VERIFICATION SANITY CHECK: Compare AI's reported HP against database HP
      // If they don't match, the AI probably identified the wrong card entirely
      // (e.g. AI says "Meowth-GX SM262" but the actual card has HP 170, while SM262 has HP 200)
      if (card.game === 'pokemon' && card.hp && verified.hp) {
        const aiHp = parseInt(card.hp);
        const dbHp = parseInt(verified.hp);
        if (aiHp && dbHp && Math.abs(aiHp - dbHp) > 20) {
          console.log(`[VERIFY] HP MISMATCH! AI says HP ${aiHp}, DB card "${verified.name}" has HP ${dbHp}. Re-searching...`);
          // The AI read the HP from the image correctly but identified the wrong card.
          // Search using the AI's HP + base name to find the actual card.
          const baseName = (card.name || '').replace(/\s*(ex|GX|EX|V|VMAX|VSTAR|LV\.X|-GX|-EX)\s*$/, '').replace(/-$/, '').trim();
          let hpMismatchResolved = false;
          try {
            const hpSearch = await axios.get('https://api.pokemontcg.io/v2/cards', {
              params: { q: `name:"${baseName}" hp:${card.hp}`, pageSize: 15 },
              timeout: 10000
            });
            const hpResults = hpSearch.data?.data;
            if (hpResults?.length) {
              // Score by attack match + card number match
              let best = null, bestScore = 0;
              for (const d of hpResults) {
                let score = 0;
                if (d.hp === String(card.hp)) score += 50;
                // Attack match
                if (card.attacks?.length && d.attacks?.length) {
                  const aiAtks = card.attacks.map(a => (typeof a === 'string' ? a : a.name || '').toLowerCase());
                  const dbAtks = d.attacks.map(a => (a.name || '').toLowerCase());
                  score += aiAtks.filter(a => dbAtks.some(da => da.includes(a) || a.includes(da))).length * 25;
                }
                // Ability match
                if (card.attacks?.length && d.abilities?.length) {
                  const aiAbil = card.attacks.map(a => (typeof a === 'string' ? a : '').toLowerCase());
                  const dbAbil = d.abilities.map(a => (a.name || '').toLowerCase());
                  score += aiAbil.filter(a => dbAbil.some(da => da.includes(a) || a.includes(da))).length * 25;
                }
                // Card number from AI (if it read one)
                if (card.card_number && d.number) {
                  const aiNum = card.card_number.replace(/\/.*/, '').replace(/^0+/, '');
                  const dbNum = d.number.replace(/^0+/, '');
                  if (aiNum === dbNum) score += 40;
                }
                console.log(`[VERIFY] HP re-search: "${d.name}" (${d.set?.name} #${d.number}, HP:${d.hp}) => score ${score}`);
                if (score > bestScore) { bestScore = score; best = d; }
              }
              if (best && bestScore >= 50) {
                console.log(`[VERIFY] HP re-search found BETTER match: "${best.name}" from ${best.set?.name} #${best.number} HP:${best.hp} (score: ${bestScore})`);
                verified = {
                  name: best.name,
                  set_name: best.set?.name,
                  set_code: best.set?.id?.toUpperCase(),
                  card_number: best.number,
                  rarity: best.rarity,
                  hp: best.hp,
                  image: best.images?.large || best.images?.small,
                  source: 'pokemontcg.io (HP re-search)'
                };
                hpMismatchResolved = true;
              }
            }
          } catch (hpErr) {
            console.error(`[VERIFY] HP re-search failed: ${hpErr.message}`);
          }

          // CRITICAL: if HP mismatch wasn't resolved (re-search timed out or found nothing better),
          // we MUST reject the original verified match — it's almost certainly the wrong card.
          // Return the AI's identification as-is; better to have a less-precise ID than a confidently wrong one.
          if (!hpMismatchResolved) {
            console.log(`[VERIFY] REJECTED — HP mismatch unresolved. Keeping AI identification as-is.`);
            return { ...card, verified: false, verify_rejected: 'hp_mismatch' };
          }
        }
      }

      console.log(`[VERIFY] CORRECTED -> "${verified.name}" from ${verified.set_name} (${verified.set_code}) #${verified.card_number}`);
      // Merge: keep AI's condition estimate but use DB's set info
      return {
        ...card,
        name: verified.name || card.name,
        set_name: verified.set_name || card.set_name,
        set_code: verified.set_code || card.set_code,
        card_number: verified.card_number || card.card_number,
        rarity: verified.rarity || card.rarity,
        reference_image: verified.image || null,
        // Direct product URLs — the whole reason for this verify pass.
        cardmarket_url: verified.cardmarket_url || null,
        tcgplayer_url: verified.tcgplayer_url || null,
        verified: true,
        db_source: verified.source
      };
    } else {
      console.log(`[VERIFY] Could not verify — using AI identification as-is`);
    }
  } catch (err) {
    console.error(`[VERIFY] Error: ${err.message}`);
  }

  return { ...card, verified: false };
}

// --- Star Wars: Unlimited via swu-db.com ---
async function verifySWU(card) {
  try {
    // Search by card name
    const searchUrl = `https://api.swu-db.com/cards/search?q=${encodeURIComponent(card.name)}`;
    console.log(`[VERIFY-SWU] Searching: ${searchUrl}`);

    const resp = await axios.get(searchUrl, { timeout: 8000 });
    const results = resp.data?.data || resp.data;

    if (Array.isArray(results) && results.length > 0) {
      // Score all results to find best match — card number is king for alt art distinction
      let best = null;
      let bestScore = -1;

      for (const c of results) {
        let score = 0;
        const cName = (c.name || c.Name || '').toLowerCase();
        const cNum = (c.number || c.Number || c.CardNumber || '').toString();
        const cSet = (c.set?.code || c.SetCode || c.set_code || '').toUpperCase();

        // Name match
        if (cName === card.name.toLowerCase()) score += 30;
        else if (cName.includes(card.name.toLowerCase())) score += 15;

        // Card number match — HIGHEST priority (distinguishes normal vs hyperspace vs showcase)
        if (card.card_number) {
          const aiNum = card.card_number.replace(/\/.*/, '').replace(/^0+/, '').replace(/^[A-Z]+ ?/, '');
          const dbNum = cNum.replace(/^0+/, '');
          if (aiNum === dbNum) score += 50;
          if (card.card_number.includes(cSet) || card.card_number.toUpperCase().startsWith(cSet)) score += 10;
        }

        // Set code match
        if (card.set_code && cSet === card.set_code.toUpperCase()) score += 20;

        // Variant match (normal vs hyperspace vs showcase)
        if (card.variant && c.variant) {
          if (c.variant.toLowerCase().includes(card.variant.toLowerCase())) score += 15;
        }

        console.log(`[VERIFY-SWU]   "${cName}" ${cSet} #${cNum} => score ${score}`);
        if (score > bestScore) { bestScore = score; best = c; }
      }

      if (!best) best = results[0];

      // Extract set info — SWU-DB has various possible field names
      const setName = best.set?.name || best.Set || best.set_name || best.expansion || '';
      const setCode = best.set?.code || best.SetCode || best.set_code || '';
      const cardNum = best.number || best.Number || best.CardNumber || best.card_number || '';

      return {
        name: best.name || best.Name || card.name,
        set_name: setName,
        set_code: setCode.toUpperCase(),
        card_number: cardNum.toString(),
        rarity: best.rarity || best.Rarity || '',
        image: best.image || best.FrontArt || best.artFront || null,
        source: 'swu-db.com'
      };
    }

    // Fallback: try the direct set search endpoints
    const sets = ['SOR', 'SHD', 'TWI', 'JTL'];
    for (const setCode of sets) {
      try {
        const setResp = await axios.get(`https://api.swu-db.com/cards/${setCode.toLowerCase()}`, { timeout: 5000 });
        const setCards = setResp.data?.data || setResp.data || [];
        if (Array.isArray(setCards)) {
          const match = setCards.find(c =>
            (c.name || c.Name || '').toLowerCase().includes(card.name.toLowerCase())
          );
          if (match) {
            return {
              name: match.name || match.Name,
              set_name: match.set?.name || setCode,
              set_code: setCode,
              card_number: (match.number || match.Number || '').toString(),
              rarity: match.rarity || match.Rarity || '',
              image: match.image || match.FrontArt || null,
              source: 'swu-db.com'
            };
          }
        }
      } catch { /* try next set */ }
    }
  } catch (err) {
    console.error(`[VERIFY-SWU] Error: ${err.message}`);
  }
  return null;
}

// --- Magic: The Gathering via Scryfall ---
async function verifyMagic(card) {
  try {
    // Try exact lookup first
    let url;
    if (card.set_code && card.card_number) {
      const num = card.card_number.replace(/\/.*/, '');
      url = `https://api.scryfall.com/cards/${card.set_code.toLowerCase()}/${num}`;
    } else {
      url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(card.name)}`;
    }

    const resp = await axios.get(url, { timeout: 8000 });
    const d = resp.data;

    return {
      name: d.name,
      set_name: d.set_name,
      set_code: d.set.toUpperCase(),
      card_number: d.collector_number,
      rarity: d.rarity,
      image: d.image_uris?.normal || d.card_faces?.[0]?.image_uris?.normal,
      cardmarket_url: d.purchase_uris?.cardmarket || null,
      tcgplayer_url: d.purchase_uris?.tcgplayer || null,
      source: 'scryfall.com'
    };
  } catch {
    // Fuzzy search fallback
    try {
      const resp = await axios.get(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(card.name)}`, { timeout: 8000 });
      const d = resp.data;
      return {
        name: d.name, set_name: d.set_name, set_code: d.set.toUpperCase(),
        card_number: d.collector_number, rarity: d.rarity,
        image: d.image_uris?.normal || d.card_faces?.[0]?.image_uris?.normal,
        cardmarket_url: d.purchase_uris?.cardmarket || null,
        tcgplayer_url: d.purchase_uris?.tcgplayer || null,
        source: 'scryfall.com'
      };
    } catch { return null; }
  }
}

// --- Pokemon via Pokemon TCG API ---
async function verifyPokemon(card) {
  try {
    // Detect if the AI identified this as a promo card (no slash in number, e.g. "SM211", "SWSH262")
    const isPromo = card.card_number && !card.card_number.includes('/') && /^[A-Z]{2,}P?\d+$/i.test(card.card_number.replace(/\s/g, ''));
    if (isPromo) {
      console.log(`[VERIFY-PKM] Detected PROMO card number: ${card.card_number}`);
    }

    // Build search queries — try exact number match first, then name-based
    const queries = [];

    // 0. For promo cards, search by the exact promo number first (most reliable)
    if (isPromo) {
      const promoNum = card.card_number.replace(/\s/g, '');
      queries.push(`number:${promoNum}`);
      // Also try with the name
      queries.push(`name:"${card.name}" number:${promoNum}`);
    }

    // 1. If we have a card number, try exact set+number match by set code
    if (card.card_number && card.set_code) {
      const num = card.card_number.replace(/\/.*/, '');
      queries.push(`name:"${card.name}" set.id:${card.set_code.toLowerCase()} number:${num}`);
    }

    // 1b. Try by SET NAME instead of set code — critical for EX-era sets where
    // the AI says "HL" but the API uses "ex5", or "MA" vs "ex4" etc.
    if (card.card_number && card.set_name) {
      const num = card.card_number.replace(/\/.*/, '');
      // Strip "EX " prefix if present since API set names sometimes omit it
      const setName = card.set_name.replace(/^EX\s+/i, '').trim();
      queries.push(`name:"${card.name}" set.name:"*${setName}*" number:${num}`);
      // Also try with the full name including EX prefix
      if (card.set_name.toLowerCase().startsWith('ex ')) {
        queries.push(`name:"${card.name}" set.name:"*${card.set_name}*" number:${num}`);
      }
    }

    // 2. Try exact name with card number (any set)
    if (card.card_number) {
      const num = card.card_number.replace(/\/.*/, '');
      queries.push(`name:"${card.name}" number:${num}`);
    }

    // 3. HP-based search if we know it — very effective for disambiguation
    if (card.hp) {
      queries.push(`name:"${card.name}" hp:${card.hp}`);
    }

    // 4. Just name as fallback
    queries.push(`name:"${card.name}"`);

    // Collect the best match across ALL queries (don't stop at first hit)
    let globalBest = null;
    let globalBestScore = -1;
    const seenCardIds = new Set();  // Avoid scoring the same card twice

    for (const query of queries) {
      console.log(`[VERIFY-PKM] Trying query: ${query}`);
      try {
        const resp = await axios.get('https://api.pokemontcg.io/v2/cards', {
          params: { q: query, pageSize: 20 },
          timeout: 10000
        });

        const results = resp.data?.data;
        if (!results?.length) continue;

        for (const d of results) {
          // Skip cards we've already scored from a previous query
          if (seenCardIds.has(d.id)) continue;
          seenCardIds.add(d.id);

          let score = 0;

          // Name match (exact name is critical — "Charizard ex" ≠ "Charizard GX")
          if (d.name?.toLowerCase() === card.name?.toLowerCase()) score += 50;
          else if (d.name?.toLowerCase().includes(card.name?.toLowerCase())) score += 20;

          // HP match — very strong signal
          if (card.hp && d.hp === card.hp) score += 40;
          else if (card.hp && d.hp) {
            const diff = Math.abs(parseInt(d.hp) - parseInt(card.hp));
            if (diff <= 10) score += 20;
          }

          // Card number match — HIGHEST priority since it distinguishes alt arts and promos
          if (card.card_number) {
            const rawAiNum = card.card_number.replace(/\s/g, '');
            const aiNum = rawAiNum.replace(/\/.*/, '').replace(/^0+/, '');
            const dbNum = (d.number || '').replace(/^0+/, '');
            // For promo cards, also compare the full promo number directly
            const aiNumNoSV = aiNum.replace(/^SV/, '');
            if (aiNum === dbNum || rawAiNum === d.number) {
              score += 80;  // Very high — exact card number is the definitive ID
            } else if (aiNumNoSV === dbNum) {
              score += 70;  // SV prefix stripped match
            } else if (isPromo && aiNum.length > 0 && dbNum.length > 0) {
              // For promos, a number MISMATCH is a very strong negative signal
              score -= 40;
            } else if (aiNum.length > 0 && dbNum.length > 0) {
              score -= 10;  // Penalty for non-promo number mismatch
            }
          }

          // Abilities match (Pokemon TCG API has separate abilities array)
          if (card.attacks?.length && d.abilities?.length) {
            const aiAbilities = card.attacks.map(a => (typeof a === 'string' ? a : '').toLowerCase());
            const dbAbilities = d.abilities.map(a => (a.name || '').toLowerCase());
            const abilityMatches = aiAbilities.filter(a => dbAbilities.some(da => da.includes(a) || a.includes(da)));
            score += abilityMatches.length * 15;
          }

          // Set total match — if AI says "44/101", the set must have ~101 cards
          // This is a strong disambiguator when same card appears across multiple sets.
          // Mismatch penalty raised: if AI clearly read "133/132" and DB card is from
          // a 165-card set, that is a near-certain wrong-set signal.
          if (card.card_number && card.card_number.includes('/')) {
            const aiSetTotal = parseInt(card.card_number.split('/')[1]?.replace(/^0+/, '') || '0');
            const dbSetTotal = parseInt(d.set?.printedTotal || d.set?.total || '0');
            if (aiSetTotal && dbSetTotal) {
              if (aiSetTotal === dbSetTotal) {
                score += 50;  // Set size matches exactly — strong confirmation
              } else {
                const diff = Math.abs(aiSetTotal - dbSetTotal);
                if (diff <= 2) score += 20;         // Close enough (OCR ±1-2)
                else if (diff <= 10) score -= 30;   // Different set probably
                else score -= 80;                    // Totally different era of set
              }
            }
          }

          // Set code match
          if (card.set_code && d.set?.id?.toUpperCase() === card.set_code.toUpperCase()) score += 25;
          // Set name match (fuzzy — AI might say "Team Magma" instead of full name)
          if (card.set_name && d.set?.name) {
            const aiSet = card.set_name.toLowerCase().replace(/^ex\s+/i, '');
            const dbSet = d.set.name.toLowerCase().replace(/^ex\s+/i, '');
            if (aiSet === dbSet) score += 25;
            else if (dbSet.includes(aiSet) || aiSet.includes(dbSet)) score += 15;
          }

          // Attack names match — very strong for disambiguation
          if (card.attacks?.length && d.attacks?.length) {
            const aiAttacks = card.attacks.map(a => (typeof a === 'string' ? a : a.name || '').toLowerCase());
            const dbAttacks = d.attacks.map(a => (a.name || '').toLowerCase());
            const matches = aiAttacks.filter(a => dbAttacks.some(da => da.includes(a) || a.includes(da)));
            score += matches.length * 15;
          }

          // Suffix type match (ex vs GX vs V etc.)
          const aiSuffix = extractPokemonSuffix(card.name);
          const dbSuffix = extractPokemonSuffix(d.name);
          if (aiSuffix && dbSuffix && aiSuffix === dbSuffix) score += 35;
          else if (aiSuffix && dbSuffix && aiSuffix !== dbSuffix) score -= 50; // Penalise wrong type

          console.log(`[VERIFY-PKM]   "${d.name}" (${d.set?.name} [${d.set?.printedTotal} cards] #${d.number}, HP:${d.hp}) => score ${score}`);

          if (score > globalBestScore) {
            globalBestScore = score;
            globalBest = d;
          }
        }
      } catch (innerErr) {
        console.error(`[VERIFY-PKM] Query failed: ${innerErr.message}`);
      }
    }

    // Return the best match found across ALL queries.
    // Threshold raised from 40 → 120: a score of 40-100 is typically just
    // "name matched but everything else is wrong", which leads to confidently
    // wrong "corrections" (e.g. modern Bulbasaur being swapped for 2002 Expedition #94
    // because only the name matched). 120 requires at least 2-3 signals to agree.
    if (globalBest && globalBestScore >= 120) {
      console.log(`[VERIFY-PKM] Best match: "${globalBest.name}" from ${globalBest.set?.name} (score: ${globalBestScore})`);
      return {
        name: globalBest.name,
        set_name: globalBest.set?.name,
        set_code: globalBest.set?.id?.toUpperCase(),
        card_number: globalBest.number,
        rarity: globalBest.rarity,
        hp: globalBest.hp,
        image: globalBest.images?.large || globalBest.images?.small,
        // Direct Cardmarket product URL for this exact print — not a search.
        cardmarket_url: globalBest.cardmarket?.url || null,
        tcgplayer_url: globalBest.tcgplayer?.url || null,
        source: 'pokemontcg.io',
        confidence_score: globalBestScore
      };
    } else if (globalBest) {
      console.log(`[VERIFY-PKM] Best match "${globalBest.name}" scored ${globalBestScore}, below threshold 120 — rejecting.`);
    }
    // FALLBACK: If nothing matched, try alternate suffixes
    // AI commonly confuses ex↔GX, V↔VMAX etc.
    const suffix = extractPokemonSuffix(card.name);
    if (suffix) {
      const baseName = card.name.replace(/\s*(ex|GX|EX|V|VMAX|VSTAR|LV\.X)\s*$/, '').trim();
      const altSuffixes = ['ex', 'GX', 'V', 'VMAX', 'VSTAR', 'EX'].filter(s => s !== suffix);
      console.log(`[VERIFY-PKM] Primary search failed. Trying alternate suffixes for "${baseName}"...`);

      for (const alt of altSuffixes) {
        const altName = `${baseName} ${alt}`;
        try {
          const hpQuery = card.hp ? ` hp:${card.hp}` : '';
          const q = `name:"${altName}"${hpQuery}`;
          console.log(`[VERIFY-PKM] Trying alt: ${q}`);
          const resp = await axios.get('https://api.pokemontcg.io/v2/cards', {
            params: { q, pageSize: 5 },
            timeout: 10000
          });
          const results = resp.data?.data;
          if (results?.length > 0) {
            // Pick the one with matching HP if possible
            let best = results[0];
            if (card.hp) {
              const hpMatch = results.find(d => d.hp === card.hp || d.hp === String(card.hp));
              if (hpMatch) best = hpMatch;
            }
            console.log(`[VERIFY-PKM] ALT MATCH: "${best.name}" from ${best.set?.name} #${best.number} HP:${best.hp}`);
            return {
              name: best.name,
              set_name: best.set?.name,
              set_code: best.set?.id?.toUpperCase(),
              card_number: best.number,
              rarity: best.rarity,
              hp: best.hp,
              image: best.images?.large || best.images?.small,
              cardmarket_url: best.cardmarket?.url || null,
              tcgplayer_url: best.tcgplayer?.url || null,
              source: 'pokemontcg.io'
            };
          }
        } catch { /* try next suffix */ }
      }

      // Last resort: search just the base name (e.g. "Charizard") and find best HP match
      try {
        console.log(`[VERIFY-PKM] Last resort: searching base name "${baseName}" with HP ${card.hp}`);
        const hpQuery = card.hp ? ` hp:${card.hp}` : '';
        const resp = await axios.get('https://api.pokemontcg.io/v2/cards', {
          params: { q: `name:"${baseName}"${hpQuery}`, pageSize: 20 },
          timeout: 10000
        });
        const results = resp.data?.data;
        if (results?.length > 0) {
          // Score by HP match and attack match
          let best = results[0];
          let bestScore = 0;
          for (const d of results) {
            let score = 0;
            if (card.hp && d.hp === String(card.hp)) score += 50;
            if (card.attacks?.length && d.attacks?.length) {
              const aiAtks = card.attacks.map(a => (typeof a === 'string' ? a : '').toLowerCase());
              const dbAtks = d.attacks.map(a => (a.name || '').toLowerCase());
              score += aiAtks.filter(a => dbAtks.includes(a)).length * 20;
            }
            if (score > bestScore) { bestScore = score; best = d; }
          }
          if (bestScore > 0) {
            console.log(`[VERIFY-PKM] BASE NAME MATCH: "${best.name}" from ${best.set?.name} #${best.number} HP:${best.hp} (score: ${bestScore})`);
            return {
              name: best.name,
              set_name: best.set?.name,
              set_code: best.set?.id?.toUpperCase(),
              card_number: best.number,
              rarity: best.rarity,
              hp: best.hp,
              image: best.images?.large || best.images?.small,
              source: 'pokemontcg.io'
            };
          }
        }
      } catch { /* give up */ }
    }
  } catch (err) {
    console.error(`[VERIFY-PKM] Error: ${err.message}`);
  }
  return null;
}

// Helper: extract Pokemon card type suffix (ex, GX, V, VMAX, VSTAR, EX)
function extractPokemonSuffix(name) {
  if (!name) return null;
  const n = name.trim();
  if (n.endsWith(' ex') || n.endsWith('-ex')) return 'ex';
  if (n.endsWith(' GX') || n.endsWith('-GX')) return 'GX';
  if (n.endsWith(' VSTAR')) return 'VSTAR';
  if (n.endsWith(' VMAX')) return 'VMAX';
  if (n.endsWith(' V')) return 'V';
  if (n.endsWith(' EX') || n.endsWith('-EX')) return 'EX';
  if (n.endsWith(' LV.X')) return 'LV.X';
  return null;
}

// --- Yu-Gi-Oh via YGOPRODeck ---
async function verifyYuGiOh(card) {
  try {
    const resp = await axios.get('https://db.ygoprodeck.com/api/v7/cardinfo.php', {
      params: { name: card.name },
      timeout: 8000
    });

    if (resp.data?.data?.length > 0) {
      const d = resp.data.data[0];
      // YGO cards can have multiple sets
      const firstSet = d.card_sets?.[0];
      return {
        name: d.name,
        set_name: firstSet?.set_name || '',
        set_code: firstSet?.set_code || '',
        card_number: firstSet?.set_code || card.card_number,
        rarity: firstSet?.set_rarity || d.race,
        image: d.card_images?.[0]?.image_url,
        source: 'ygoprodeck.com'
      };
    }
  } catch (err) {
    // Try fuzzy search
    try {
      const resp = await axios.get('https://db.ygoprodeck.com/api/v7/cardinfo.php', {
        params: { fname: card.name },
        timeout: 8000
      });
      if (resp.data?.data?.length > 0) {
        const d = resp.data.data[0];
        const firstSet = d.card_sets?.[0];
        return {
          name: d.name, set_name: firstSet?.set_name || '', set_code: firstSet?.set_code || '',
          card_number: firstSet?.set_code || '', rarity: firstSet?.set_rarity || '',
          image: d.card_images?.[0]?.image_url, source: 'ygoprodeck.com'
        };
      }
    } catch { return null; }
  }
  return null;
}

// --- Generic fallback (for One Piece, Lorcana, Digimon, etc.) ---
// Uses a combination of available community APIs
async function verifyGeneric(card) {
  // Try a few known community APIs based on game
  const endpoints = [];

  if (card.game === 'onepiece') {
    // One Piece TCG doesn't have a great free API, but we can try
    // The card number format is usually the set identifier (e.g. OP06-001)
    // We'll trust the AI's identification more here
    return null;
  }

  if (card.game === 'lorcana') {
    // Try Lorcana API if available
    try {
      const resp = await axios.get(`https://api.lorcana-api.com/cards/fetch?search=${encodeURIComponent(card.name)}`, { timeout: 8000 });
      if (resp.data?.length > 0) {
        const d = resp.data[0];
        return {
          name: d.Name || d.name,
          set_name: d.Set_Name || d.set || '',
          set_code: d.Set_ID || '',
          card_number: d.Card_Num || d.number || '',
          rarity: d.Rarity || '',
          image: d.Image || null,
          source: 'lorcana-api.com'
        };
      }
    } catch { /* fall through */ }
  }

  return null;
}


// ============================================================
// CARDMARKET — HEADLESS BROWSER SCRAPING (bypasses 403 blocks)
// ============================================================
// Uses Puppeteer (real Chrome) so Cardmarket sees a normal browser visit.
// A single browser instance is shared and reused for speed.

const CONDITION_TO_CM = { 'NM': 2, 'LP': 4, 'MP': 5, 'HP': 6, 'DMG': 7 };

const CM_GAME_SLUGS = {
  'magic': 'Magic',
  'pokemon': 'Pokemon',
  'yugioh': 'YuGiOh',
  'onepiece': 'OnePiece',
  'lorcana': 'Lorcana',
  'dragonball': 'DragonBallSuper',
  'starwars': 'StarWarsUnlimited',
  'digimon': 'Digimon',
  'fleshandblood': 'FleshAndBlood',
  'weiss': 'WeissSchwarz',
  'cardfight': 'VanguardZero'
};

function getGameSlug(game) {
  return CM_GAME_SLUGS[game] || null;
}

// ============================================================
// CARDMARKET — Direct URL Builder (no scraping needed)
// ============================================================
// Builds a Cardmarket search URL the user can tap to check prices.
// Cloudflare blocks automated scraping, so we give the user a direct link instead.
function buildCardmarketUrl(card) {
  const gameSlug = getGameSlug(card.game);
  const condCode = CONDITION_TO_CM[card.condition_estimate] || 2;

  // We no longer guess direct product URLs — Cardmarket's slug rules have too
  // many edge cases (alt-arts, punctuation, variant suffixes) and a guessed
  // URL 404s more often than it works. API-provided URLs (from pokemontcg.io
  // / Scryfall) still override this in the caller when available.

  // Build a search URL that targets the exact card.
  // Cardmarket Pokémon product names include set code + number in parens,
  // e.g. "Slaking ex (SSP 147)" — so including them in the search matches.
  const num = card.card_number ? card.card_number.replace(/\/.*/, '').replace(/^0+/, '') : '';
  const setCode = (card.set_code || card.setCode || '').toUpperCase();

  // Primary: name + set code + number in parentheses (matches Cardmarket product name format)
  let searchTerm = card.name || '';
  if (card.game === 'pokemon' && setCode && num) {
    searchTerm = `${card.name} (${setCode} ${num})`;
  } else if (num) {
    searchTerm = `${card.name} ${num}`;
  }

  const searchUrl = gameSlug
    ? `https://www.cardmarket.com/en/${gameSlug}/Products/Search?searchString=${encodeURIComponent(searchTerm)}`
    : `https://www.cardmarket.com/en/Search?searchString=${encodeURIComponent(searchTerm)}`;

  // Narrower fallback — just name (in case parens format doesn't match)
  const fallbackTerm = card.name || '';
  const fallbackUrl = gameSlug
    ? `https://www.cardmarket.com/en/${gameSlug}/Products/Search?searchString=${encodeURIComponent(fallbackTerm)}`
    : `https://www.cardmarket.com/en/Search?searchString=${encodeURIComponent(fallbackTerm)}`;

  return {
    product_url: null,
    product_url_filtered: null,
    search_url: searchUrl,
    filtered_search_url: `${searchUrl}&language=1&minCondition=${condCode}`,
    narrow_search_url: fallbackUrl,
    source: 'cardmarket_link'
  };
}

// ============================================================
// Lightweight Cardmarket price fetch — direct URL, no search needed
// ============================================================
// Since we build the exact product URL, we can try a simple HTTP request.
// Cloudflare may or may not block this — if it does, we fall back to API prices.
async function fetchCardmarketPrice(productUrl, condition) {
  if (!productUrl || !productUrl.includes('cardmarket.com')) return null;

  const condCode = CONDITION_TO_CM[condition] || 2;
  // Fetch the filtered offers page (English + condition)
  const filteredUrl = productUrl.includes('?')
    ? `${productUrl}&language=1&minCondition=${condCode}`
    : `${productUrl}?language=1&minCondition=${condCode}`;

  try {
    console.log(`[CM-FETCH] Trying direct fetch: ${filteredUrl}`);
    const resp = await axios.get(filteredUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1'
      },
      timeout: 10000,
      maxRedirects: 5
    });

    const html = resp.data;
    const title = typeof html === 'string' ? html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] || '' : '';

    // Check if Cloudflare blocked us
    if (title.includes('Just a moment') || title.includes('Attention') || html.length < 5000) {
      console.log(`[CM-FETCH] Cloudflare blocked (title: "${title}", size: ${html.length})`);
      return null;
    }

    console.log(`[CM-FETCH] Got page! Title: "${title}", size: ${html.length}`);

    // Extract prices using regex (no cheerio needed)
    const result = { url: productUrl, filtered_url: filteredUrl, source: 'cardmarket_live' };

    // 1. Extract trend price: <dt>Price Trend</dt><dd>... 3,62 € ...</dd>
    const trendMatch = html.match(/Price\s*Trend[\s\S]*?([\d]+[.,][\d]{2})\s*€/i);
    if (trendMatch) result.trend = parseFloat(trendMatch[1].replace(',', '.'));

    // 2. Extract "From" / lowest price
    const fromMatch = html.match(/(?:From|Ab|Available from)[\s\S]*?([\d]+[.,][\d]{2})\s*€/i);
    if (fromMatch) result.low = parseFloat(fromMatch[1].replace(',', '.'));

    // 3. Extract 30-day average
    const avg30Match = html.match(/30[- ]day[s]?\s*average[\s\S]*?([\d]+[.,][\d]{2})\s*€/i);
    if (avg30Match) result.avg30 = parseFloat(avg30Match[1].replace(',', '.'));

    // 4. Find offer prices on the filtered page (look for € prices in offer rows)
    const offerPrices = [];
    const priceRegex = /(\d+[.,]\d{2})\s*€/g;
    let match;

    // Look specifically in the offers/seller section (after "Seller" heading)
    const sellerSection = html.split(/Seller|seller/i)[1] || '';
    while ((match = priceRegex.exec(sellerSection)) !== null) {
      const price = parseFloat(match[1].replace(',', '.'));
      if (price > 0.01 && price < 50000) {
        offerPrices.push(price);
      }
    }

    // Deduplicate and sort
    const uniqueOffers = [...new Set(offerPrices)].sort((a, b) => a - b);

    if (uniqueOffers.length > 0) {
      result.offers_low = uniqueOffers[0];
      result.total_offers = uniqueOffers.length;
      result.note = `Lowest English ${condition}+ offer: ${uniqueOffers[0].toFixed(2)}€ (${uniqueOffers.length} sellers)`;
      console.log(`[CM-FETCH] Found ${uniqueOffers.length} offer prices, lowest: ${uniqueOffers[0]}€`);
    }

    // Set the best price
    result.price = result.offers_low || result.low || result.trend;
    if (!result.price) {
      console.log('[CM-FETCH] Could not extract any prices from page');
      return null;
    }

    console.log(`[CM-FETCH] SUCCESS — price: ${result.price}€, trend: ${result.trend || '?'}€, offers_low: ${result.offers_low || '?'}€`);
    return result;

  } catch (err) {
    const status = err.response?.status;
    if (status === 403) {
      console.log('[CM-FETCH] Blocked by Cloudflare (403). Falling back to API prices.');
    } else {
      console.log(`[CM-FETCH] Failed: ${err.message}. Falling back to API prices.`);
    }
    return null;
  }
}

// ============================================================
// JustTCG API — TCGPlayer USD prices for ALL TCGs
// Returns condition-specific market prices from TCGPlayer
// Free tier: 100 requests/day
// ============================================================
const JUSTTCG_GAME_MAP = {
  'pokemon': 'pokemon',
  'magic': 'mtg',
  'yugioh': 'yugioh',
  'lorcana': 'lorcana',
  'onepiece': 'onepiece',
  'digimon': 'digimon',
  'starwars': 'star-wars-unlimited',
  'flesh_and_blood': 'flesh-and-blood'
};

const JUSTTCG_CONDITION_MAP = {
  'NM': 'Near Mint', 'LP': 'Lightly Played', 'MP': 'Moderately Played',
  'HP': 'Heavily Played', 'DMG': 'Damaged'
};

async function fetchJustTCGPrice(card) {
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return null;

  const game = JUSTTCG_GAME_MAP[card.game] || card.game;
  const conditionFull = JUSTTCG_CONDITION_MAP[card.condition_estimate] || 'Near Mint';
  const conditionShort = card.condition_estimate || 'NM';

  try {
    // JustTCG works best with name + card_number in the q parameter
    // Set param uses slug format (e.g. "sv03-obsidian-flames-pokemon") which is hard to predict
    // So we include the card number in the text search for precision
    let searchQuery = card.name;
    if (card.card_number) {
      // Strip any slash format (223/197 → 223) for cleaner search
      const num = card.card_number.replace(/\/.*/, '');
      searchQuery = `${card.name} ${num}`;
    }

    const params = { q: searchQuery, game: game, limit: 5 };

    console.log(`[JustTCG] Searching: game=${game}, q="${params.q}"`);

    const resp = await axios.get('https://api.justtcg.com/v1/cards', {
      params,
      headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
      timeout: 10000
    });

    const data = resp.data?.data;
    if (!data || data.length === 0) {
      // Fallback: try just the name without number
      console.log('[JustTCG] No results, trying name only...');
      const resp2 = await axios.get('https://api.justtcg.com/v1/cards', {
        params: { q: card.name, game: game, limit: 5 },
        headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
        timeout: 10000
      });
      const data2 = resp2.data?.data;
      if (!data2 || data2.length === 0) {
        console.log('[JustTCG] No results found');
        return null;
      }
      return parseJustTCGResult(data2, card, conditionFull, conditionShort);
    }

    return parseJustTCGResult(data, card, conditionFull, conditionShort);
  } catch (err) {
    if (err.response?.status === 429) {
      console.log('[JustTCG] Rate limited (100/day) — skipping');
    } else if (err.response?.status === 401) {
      console.log('[JustTCG] Invalid API key');
    } else {
      console.log(`[JustTCG] Error: ${err.message}`);
    }
    return null;
  }
}

function parseJustTCGResult(data, card, conditionFull, conditionShort) {
  // Find best match — score by name + number + set
  let best = data[0];
  let bestScore = 0;
  for (const item of data) {
    let score = 0;
    if (item.name?.toLowerCase().includes(card.name.toLowerCase())) score += 50;
    if (card.card_number) {
      const num = card.card_number.replace(/\/.*/, '');
      const itemNum = (item.number || '').replace(/\/.*/, '');
      if (itemNum === num) score += 60;
    }
    if (card.set_name && item.set_name?.toLowerCase().includes(card.set_name.toLowerCase())) score += 30;
    if (score > bestScore) { bestScore = score; best = item; }
  }

  // Find the right variant — match condition, prefer Normal/Holofoil printing
  const variants = best.variants || [];
  let bestVariant = variants[0];

  // First try: exact condition match
  const condMatch = variants.filter(v => v.condition === conditionFull);
  if (condMatch.length > 0) {
    // Prefer Normal or Holofoil printing
    bestVariant = condMatch.find(v => v.printing === 'Normal' || v.printing === 'Holofoil') || condMatch[0];
  }

  const price = bestVariant?.price || null;
  const result = {
    source: 'justtcg',
    name: best.name,
    set: best.set_name || best.set,
    set_slug: best.set,
    card_number: best.number,
    condition: conditionShort,
    condition_full: bestVariant?.condition || conditionFull,
    printing: bestVariant?.printing || null,
    // JustTCG returns TCGPlayer USD prices
    price_usd: price,
    price_eur: price ? Math.round(price * USD_TO_EUR * 100) / 100 : null,
    currency: 'USD',
    last_updated: bestVariant?.lastUpdated ? new Date(bestVariant.lastUpdated * 1000).toISOString() : null,
    // Price analytics
    price_change_7d: bestVariant?.priceChange7d || null,
    price_change_30d: bestVariant?.priceChange30d || null,
    avg_30d: bestVariant?.avgPrice30d || null,
    min_30d: bestVariant?.minPrice30d || null,
    max_30d: bestVariant?.maxPrice30d || null,
  };

  if (result.price_usd) {
    console.log(`[JustTCG] Found: ${result.name} (${result.set} #${result.card_number}) = $${result.price_usd} USD / ~${result.price_eur}€ [${result.condition_full}, ${result.printing}]`);
  } else {
    console.log(`[JustTCG] Found card but no price: ${result.name} (${result.set})`);
  }

  return result;
}


// ============================================================
// TCGGO Pokemon TCG API via RapidAPI — real-time Cardmarket EUR + TCGPlayer USD
// Host: pokemon-tcg-api.p.rapidapi.com (requires separate subscription)
// Subscribe at: https://rapidapi.com/tcggopro/api/pokemon-tcg-api
// Response format (from docs):
//   { id, name, name_numbered, card_number, rarity,
//     prices: {
//       cardmarket: { currency:"EUR", lowest_near_mint, lowest_near_mint_DE/FR/ES/IT,
//                     30d_average, 7d_average, graded: { psa: {psa10, psa9}, cgc: {cgc10} } },
//       tcg_player: { currency:"USD", market_price, mid_price }
//     },
//     episode: { name, code }, artist: { name }, image }
// ============================================================
async function fetchRapidAPICardmarketPrice(card) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return null;

  // Only Pokemon is supported on this API
  if (card.game !== 'pokemon') {
    return null;
  }

  try {
    let searchTerm = card.name;
    if (card.card_number) {
      const num = card.card_number.replace(/\/.*/, '');
      searchTerm = `${card.name} ${num}`;
    }

    console.log(`[TCGGO] Searching: "${searchTerm}"`);

    // Endpoint: /cards/search with "search" param (found via probing)
    // "search" param with name+number returns exact match as first result
    // "name" param only matches exact card name (no number in query)
    const resp = await axios.get('https://pokemon-tcg-api.p.rapidapi.com/cards/search', {
      params: { search: searchTerm, per_page: 5 },
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': 'pokemon-tcg-api.p.rapidapi.com',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    const data = resp.data?.data;
    if (!data || data.length === 0) {
      console.log('[TCGGO] No results');
      return null;
    }

    // Find best match by name + card number
    let best = data[0];
    let bestScore = 0;
    for (const item of data) {
      let score = 0;
      if (item.name?.toLowerCase().includes(card.name.toLowerCase())) score += 50;
      if (card.card_number) {
        const num = card.card_number.replace(/\/.*/, '');
        const itemNum = String(item.card_number);
        if (itemNum === num || itemNum === card.card_number) score += 60;
      }
      if (card.set_name && item.episode?.name?.toLowerCase().includes(card.set_name.toLowerCase())) score += 30;
      if (score > bestScore) { bestScore = score; best = item; }
    }

    // Extract from the documented response structure
    const cm = best.prices?.cardmarket || {};
    const tcg = best.prices?.tcg_player || {};

    const result = {
      source: 'rapidapi_cm',
      name: best.name,
      name_numbered: best.name_numbered,
      set: best.episode?.name || null,
      set_code: best.episode?.code || null,
      card_number: String(best.card_number),
      rarity: best.rarity,
      image: best.image || null,
      tcggo_url: best.tcggo_url || null,
      // Cardmarket EUR prices
      lowest_nm: cm.lowest_near_mint || null,
      lowest_de: cm.lowest_near_mint_DE || null,
      lowest_fr: cm.lowest_near_mint_FR || null,
      lowest_es: cm.lowest_near_mint_ES || null,
      lowest_it: cm.lowest_near_mint_IT || null,
      avg30: cm['30d_average'] || null,
      avg7: cm['7d_average'] || null,
      // Graded prices
      graded_psa10: cm.graded?.psa?.psa10 || null,
      graded_psa9: cm.graded?.psa?.psa9 || null,
      graded_cgc10: cm.graded?.cgc?.cgc10 || null,
      // TCGPlayer USD prices
      tcgplayer_market: tcg.market_price || null,
      tcgplayer_mid: tcg.mid_price || null,
    };

    // Best Cardmarket price = lowest NM across all regions
    result.price = result.lowest_nm || result.avg7 || result.avg30;

    if (result.price) {
      console.log(`[TCGGO] Found: ${result.name} (${result.set} #${result.card_number}) = ${result.price}€ NM (30d avg: ${result.avg30 || '?'}€, DE: ${result.lowest_de || '?'}€)`);
    } else {
      console.log(`[TCGGO] Card found but no Cardmarket price: ${result.name}`);
    }

    return result;
  } catch (err) {
    if (err.response?.status === 429) {
      console.log('[TCGGO] Rate limited — skipping');
    } else if (err.response?.status === 403) {
      console.log('[TCGGO] Not subscribed — subscribe at https://rapidapi.com/tcggopro/api/pokemon-tcg-api');
    } else if (err.response?.status === 401) {
      console.log('[TCGGO] Auth error — check RAPIDAPI_KEY');
    } else {
      console.log(`[TCGGO] Error: ${err.response?.status || ''} ${err.message}`);
    }
    return null;
  }
}


// Graceful shutdown
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());




// ============================================================
// PRICING — Free APIs (Scryfall for Magic, Pokemon TCG API)
// ============================================================

async function priceMagicCard(card) {
  const prices = { cardmarket: null, ebay: null, source: 'scryfall' };

  try {
    let url;
    if (card.set_code && card.card_number) {
      const setCode = card.set_code.toLowerCase();
      const num = card.card_number.replace(/\/.*/, '');
      url = `https://api.scryfall.com/cards/${setCode}/${num}`;
    } else {
      url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(card.name)}`;
    }

    const resp = await axios.get(url, { timeout: 8000 });
    const data = resp.data;

    if (data.prices) {
      const isFoil = card.variant && card.variant !== 'normal';
      const tcgPrice = isFoil ? data.prices.usd_foil : data.prices.usd;

      if (tcgPrice) {
        prices.tcgplayer = {
          price: parseFloat(tcgPrice),
          currency: 'USD',
          url: data.purchase_uris?.tcgplayer || null
        };
      }

      // Scryfall also has EUR (Cardmarket) prices!
      const eurPrice = isFoil ? data.prices.eur_foil : data.prices.eur;
      if (eurPrice) {
        prices.cardmarket_price = parseFloat(eurPrice);
        prices.cardmarket_source = 'scryfall.com';
        console.log(`[PRICE] Cardmarket EUR price from Scryfall: ${eurPrice}€ (${data.name})`);
      }
    }

    // Capture Cardmarket direct URL from Scryfall (for MTG cards)
    if (data.purchase_uris?.cardmarket) {
      prices.cardmarket_product_url = data.purchase_uris.cardmarket;
    }

    prices.scryfall = {
      name: data.name,
      set: data.set_name,
      set_code: data.set,
      collector_number: data.collector_number,
      image: data.image_uris?.normal || data.card_faces?.[0]?.image_uris?.normal,
      uri: data.scryfall_uri
    };

  } catch (err) {
    console.error('Scryfall error:', err.message);
  }

  return prices;
}

async function pricePokemonCard(card) {
  const prices = { cardmarket: null, ebay: null, source: 'pokemontcg' };

  try {
    let query;
    if (card.set_code && card.card_number) {
      const num = card.card_number.replace(/\/.*/, '');
      query = `number:${num}`;
      if (card.set_code) {
        query += ` set.id:${card.set_code.toLowerCase()}`;
      }
    } else {
      query = `name:"${card.name}"`;
    }

    const resp = await axios.get(`https://api.pokemontcg.io/v2/cards`, {
      params: { q: query, pageSize: 5 },
      timeout: 10000
    });

    if (resp.data.data && resp.data.data.length > 0) {
      let bestMatch = resp.data.data[0];
      if (card.card_number) {
        const targetNum = card.card_number.replace(/\/.*/, '');
        const exact = resp.data.data.find(c => c.number === targetNum);
        if (exact) bestMatch = exact;
      }

      const d = bestMatch;

      if (d.tcgplayer?.prices) {
        const tcgPrices = d.tcgplayer.prices;
        const variant = card.variant === 'reverse_holo' ? tcgPrices.reverseHolofoil : (tcgPrices.holofoil || tcgPrices.normal);
        if (variant) {
          prices.tcgplayer = {
            price: variant.market || variant.mid,
            low: variant.low,
            currency: 'USD',
            url: d.tcgplayer.url || null
          };
        }
      }

      // Extract Cardmarket prices from the Pokemon TCG API (it includes them!)
      // Priority: lowPrice (actual lowest listing) > lowPriceExPlus > trendPrice
      if (d.cardmarket?.prices) {
        const cmPrices = d.cardmarket.prices;
        const isFoil = card.variant && !['normal', 'reverse_holo'].includes(card.variant);

        // Use LOWEST price, not trend — user wants to know what they'd actually pay
        const cmPrice = isFoil
          ? (cmPrices.reverseHoloLow || cmPrices.reverseHoloTrend || cmPrices.lowPrice || cmPrices.trendPrice)
          : (cmPrices.lowPriceExPlus || cmPrices.lowPrice || cmPrices.trendPrice);

        // Also grab trend for reference
        const cmTrend = cmPrices.trendPrice;

        if (cmPrice) {
          prices.cardmarket_price = cmPrice;
          prices.cardmarket_trend = cmTrend;
          prices.cardmarket_source = 'pokemontcg.io';
          console.log(`[PRICE] Cardmarket from API: lowest=${cmPrice}€, trend=${cmTrend}€ (${d.name} ${d.set?.name} #${d.number})`);
        }

        // Also pass the Cardmarket URL from the API
        if (d.cardmarket?.url) {
          prices.cardmarket_product_url = d.cardmarket.url;
        }
      }

      prices.pokemontcg = {
        name: d.name,
        set: d.set?.name,
        set_code: d.set?.id,
        number: d.number,
        image: d.images?.large || d.images?.small,
        rarity: d.rarity
      };
    }
  } catch (err) {
    console.error('Pokemon TCG API error:', err.message);
  }

  return prices;
}


// ============================================================
// PRICING — eBay Sold Listings
// ============================================================

async function getEbayToken() {
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  if (!appId || !certId) return null;

  try {
    const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');
    const resp = await axios.post('https://api.ebay.com/identity/v1/oauth2/token', new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope'
    }), {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 10000
    });
    return resp.data.access_token;
  } catch (err) {
    console.error('eBay token error:', err.message);
    return null;
  }
}

async function priceEbaySold(card) {
  const token = await getEbayToken();
  if (!token) {
    console.log('[eBay] No token available');
    return null;
  }

  // Build search queries — try specific first, then broader
  const queries = [];

  // Most specific: name + set + number
  let specific = card.name;
  if (card.set_code) specific += ` ${card.set_code}`;
  if (card.card_number) specific += ` ${card.card_number.replace(/\/.*/, '')}`;
  queries.push(specific);

  // Medium: name + game
  const gameNames = {
    'pokemon': 'pokemon tcg', 'magic': 'mtg', 'starwars': 'star wars unlimited',
    'onepiece': 'one piece tcg', 'yugioh': 'yugioh', 'lorcana': 'lorcana',
    'dragonball': 'dragon ball super', 'digimon': 'digimon tcg', 'fleshandblood': 'flesh and blood'
  };
  if (card.card_number) {
    queries.push(`${card.name} ${card.card_number} ${gameNames[card.game] || ''}`);
  }

  // Broadest: just the name + game
  queries.push(`${card.name} ${gameNames[card.game] || 'tcg'} card`);

  for (const query of queries) {
    console.log(`[eBay] Searching: "${query}"`);
    try {
      const resp = await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
        params: {
          q: query,
          category_ids: '183454', // Collectible Card Games category
          filter: 'buyingOptions:{FIXED_PRICE|AUCTION}',
          sort: 'price',
          limit: 15
        },
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_IE' // Ireland for EUR
        },
        timeout: 10000
      });

      if (resp.data?.itemSummaries?.length > 0) {
        const items = resp.data.itemSummaries;
        console.log(`[eBay] Found ${items.length} listings`);

        const prices = items
          .filter(i => i.price?.value)
          .map(i => ({
            price: parseFloat(i.price.value),
            currency: i.price.currency,
            title: i.title,
            url: i.itemWebUrl
          }))
          .filter(i => i.price > 0 && i.price < 10000) // Filter out obvious junk
          .sort((a, b) => a.price - b.price);

        if (prices.length > 0) {
          const median = prices[Math.floor(prices.length / 2)];
          return {
            median_price: median.price,
            low: prices[0].price,
            high: prices[prices.length - 1].price,
            sample_size: prices.length,
            currency: median.currency || 'EUR',
            recent_sales: prices.slice(0, 5).map(i => ({
              title: i.title,
              price: i.price,
              currency: i.currency,
              url: i.url
            }))
          };
        }
      } else {
        console.log(`[eBay] No results for this query`);
      }
    } catch (err) {
      console.error(`[eBay] API error for "${query}":`, err.response?.data?.errors?.[0]?.message || err.message);
    }
  }

  console.log('[eBay] No results found across all search strategies');
  return null;
}


// ============================================================
// COMBINED PRICING ENDPOINT
// ============================================================

app.post('/api/price', async (req, res) => {
  try {
    const { card } = req.body;
    if (!card || !card.name) {
      return res.status(400).json({ error: 'Card data required' });
    }

    const conditionMultipliers = {
      'NM': 1.0, 'LP': 0.85, 'MP': 0.70, 'HP': 0.50, 'DMG': 0.30
    };
    const conditionMult = conditionMultipliers[card.condition_estimate] || 1.0;
    const buyPercentage = (req.body.buyPercentage || process.env.DEFAULT_BUY_PERCENTAGE || 60) / 100;

    // Build Cardmarket direct link (user can tap to check live prices)
    const cmLinks = buildCardmarketUrl(card);

    // Run ALL pricing lookups in parallel for speed
    const pricingPromises = [];

    // 0. Try live Cardmarket fetch if we have a direct product URL
    if (cmLinks.product_url) {
      pricingPromises.push(
        fetchCardmarketPrice(cmLinks.product_url, card.condition_estimate || 'NM')
          .then(r => ({ type: 'cardmarket_live', data: r }))
      );
    }

    // 1. Game-specific free APIs (TCGPlayer prices + reference images)
    if (card.game === 'magic') {
      pricingPromises.push(priceMagicCard(card).then(r => ({ type: 'game_api', data: r })));
    } else if (card.game === 'pokemon') {
      pricingPromises.push(pricePokemonCard(card).then(r => ({ type: 'game_api', data: r })));
    }

    // 2. JustTCG API — condition-specific live Cardmarket prices (all games)
    if (process.env.JUSTTCG_API_KEY) {
      pricingPromises.push(
        fetchJustTCGPrice(card).then(r => ({ type: 'justtcg', data: r }))
      );
    }

    // 3. TCGGO API via RapidAPI — real-time Cardmarket EUR prices + TCGPlayer USD
    // Requires subscription to "Pokemon TCG API" at:
    //   https://rapidapi.com/tcggopro/api/pokemon-tcg-api
    // (NOT "cardmarket-api-tcg" which is a different product with empty data)
    if (process.env.RAPIDAPI_KEY) {
      pricingPromises.push(
        fetchRapidAPICardmarketPrice(card).then(r => ({ type: 'rapidapi_cm', data: r }))
      );
    }

    // 4. eBay sold listings
    pricingPromises.push(
      priceEbaySold(card).then(r => ({ type: 'ebay', data: r }))
    );

    const results = await Promise.all(pricingPromises);

    // Assemble final pricing
    let pricing = {
      card: card,
      cardmarket: {
        url: cmLinks.search_url,
        filtered_url: cmLinks.filtered_search_url,
        search_url: cmLinks.search_url,
        source: 'cardmarket_link',
        note: 'Tap to check live Cardmarket prices'
      },
      ebay: null,
      tcgplayer: null,
      reference_image: null,
      buy_price: null,
      condition_multiplier: conditionMult,
      buy_percentage: buyPercentage
    };

    for (const result of results) {
      if (result.type === 'game_api' && result.data) {
        if (result.data.tcgplayer) {
          pricing.tcgplayer = result.data.tcgplayer;
        }
        if (result.data.scryfall?.image || result.data.pokemontcg?.image) {
          pricing.reference_image = result.data.scryfall?.image || result.data.pokemontcg?.image;
        }
        if (result.data.scryfall) pricing.verified_card = result.data.scryfall;
        if (result.data.pokemontcg) pricing.verified_card = result.data.pokemontcg;

        // Extract Cardmarket price from API (lowest available, NOT trend)
        if (result.data.cardmarket_price) {
          pricing.cardmarket.price = result.data.cardmarket_price;
          pricing.cardmarket.trend = result.data.cardmarket_trend || null;
          pricing.cardmarket.source = result.data.cardmarket_source || 'api';
          pricing.cardmarket.note = `Lowest via API · ${result.data.cardmarket_trend ? 'Trend: ' + result.data.cardmarket_trend.toFixed(2) + '€' : ''}`;
        }

        // Use direct Cardmarket product URL ONLY if it's an actual cardmarket.com URL
        // (Pokemon TCG API returns redirect URLs like prices.pokemontcg.io — skip those)
        if (result.data.cardmarket_product_url && result.data.cardmarket_product_url.includes('cardmarket.com')) {
          pricing.cardmarket.url = result.data.cardmarket_product_url;
          pricing.cardmarket.filtered_url = result.data.cardmarket_product_url;
          console.log(`[CM-URL] Using Cardmarket URL from API: ${result.data.cardmarket_product_url}`);
        }
      }

      if (result.type === 'ebay' && result.data) {
        pricing.ebay = result.data;
      }

      // Live Cardmarket price from direct page fetch — overrides API price
      if (result.type === 'cardmarket_live' && result.data) {
        console.log(`[CM-LIVE] Got live Cardmarket data:`, JSON.stringify(result.data));
        pricing.cardmarket.price = result.data.low || result.data.trend || pricing.cardmarket.price;
        pricing.cardmarket.trend = result.data.trend || pricing.cardmarket.trend;
        pricing.cardmarket.low = result.data.low || null;
        pricing.cardmarket.avg30 = result.data.avg30 || null;
        pricing.cardmarket.source = 'cardmarket_live';
        pricing.cardmarket.verified = true;
        pricing.cardmarket.note = `Live price from Cardmarket${result.data.trend ? ' · Trend: ' + result.data.trend.toFixed(2) + '€' : ''}`;
        if (result.data.offers && result.data.offers.length > 0) {
          pricing.cardmarket.offers = result.data.offers.slice(0, 5);
        }
      }

      // JustTCG — condition-specific TCGPlayer USD prices
      if (result.type === 'justtcg' && result.data) {
        const jt = result.data;
        if (jt.price_usd) {
          console.log(`[PRICE] JustTCG: $${jt.price_usd} USD / ~${jt.price_eur}€ [${jt.condition_full}, ${jt.printing}]`);
        }
        // Store as separate data source for cross-check display
        pricing.justtcg = {
          price_usd: jt.price_usd,
          price_eur: jt.price_eur,
          condition: jt.condition,
          condition_full: jt.condition_full,
          printing: jt.printing,
          name: jt.name,
          set: jt.set,
          card_number: jt.card_number,
          source: 'justtcg',
          currency: 'USD',
          avg_30d: jt.avg_30d,
          price_change_30d: jt.price_change_30d,
          last_updated: jt.last_updated
        };
        // If we have no TCGPlayer data yet, use JustTCG's price
        if (!pricing.tcgplayer && jt.price_usd) {
          pricing.tcgplayer = {
            price: jt.price_usd,
            source: 'justtcg',
            condition: jt.condition_full,
            printing: jt.printing,
            verified: true
          };
        }
      }

      // TCGGO / RapidAPI — real-time Cardmarket EUR + TCGPlayer USD
      if (result.type === 'rapidapi_cm' && result.data?.price) {
        const rd = result.data;
        console.log(`[PRICE] TCGGO: ${rd.price}€ NM (avg30: ${rd.avg30 || '?'}€, DE: ${rd.lowest_de || '?'}€)`);
        // This is the best EUR source — overrides everything except direct Cardmarket scrape
        if (pricing.cardmarket.source !== 'cardmarket_live') {
          pricing.cardmarket.price = rd.price;
          pricing.cardmarket.avg30 = rd.avg30 || pricing.cardmarket.avg30;
          pricing.cardmarket.avg7 = rd.avg7 || null;
          pricing.cardmarket.source = 'rapidapi_cm';
          pricing.cardmarket.verified = true;
          pricing.cardmarket.note = `Live NM from TCGGO${rd.avg30 ? ' · 30d avg: ' + rd.avg30.toFixed(2) + '€' : ''}`;
        }
        // Always store full data for cross-check display
        pricing.rapidapi_cm = {
          price: rd.price,
          lowest_nm: rd.lowest_nm,
          avg7: rd.avg7,
          avg30: rd.avg30,
          lowest_de: rd.lowest_de,
          lowest_fr: rd.lowest_fr,
          lowest_es: rd.lowest_es,
          lowest_it: rd.lowest_it,
          graded_psa10: rd.graded_psa10,
          graded_psa9: rd.graded_psa9,
          tcgplayer_market: rd.tcgplayer_market,
          image: rd.image,
          source: 'rapidapi_cm'
        };
        // Use TCGGO image if we don't have one
        if (!pricing.reference_image && rd.image) {
          pricing.reference_image = rd.image;
        }
      }
    }

    // GRADED card pricing — overrides everything else.
    // If the card is slabbed (PSA/BGS/CGC/SGC), use graded comp from TCGGO.
    let bestPrice = null;
    let priceSource = '';
    let priceCurrency = 'EUR';
    let isGraded = false;

    if (card.graded && card.graded.company && card.graded.grade) {
      isGraded = true;
      const company = String(card.graded.company).toUpperCase();
      const grade = Number(card.graded.grade);
      const r = pricing.rapidapi_cm || {};
      // Pick matching graded comp; fall back to nearest available.
      let gp = null, gLabel = '';
      if (company === 'PSA' && grade === 10 && r.graded_psa10) { gp = r.graded_psa10; gLabel = 'PSA 10'; }
      else if (company === 'PSA' && grade === 9 && r.graded_psa9) { gp = r.graded_psa9; gLabel = 'PSA 9'; }
      else if ((company === 'CGC' || company === 'BGS') && grade >= 9.5 && r.graded_cgc10) { gp = r.graded_cgc10; gLabel = `${company} ${grade}`; }
      // Closest-match fallbacks
      else if (grade >= 9.5 && r.graded_psa10) { gp = r.graded_psa10; gLabel = `${company} ${grade} (using PSA 10 comp)`; }
      else if (grade >= 8.5 && r.graded_psa9) { gp = r.graded_psa9; gLabel = `${company} ${grade} (using PSA 9 comp)`; }

      if (gp) {
        bestPrice = gp;
        priceSource = `Graded ${gLabel} · TCGGO`;
      }
    }

    if (!bestPrice && pricing.cardmarket?.price) {
      bestPrice = pricing.cardmarket.price;
      const sourceLabels = {
        'rapidapi_cm': 'RapidAPI CM (live)',
        'cardmarket_live': 'Cardmarket (live)',
        'api': 'Cardmarket (API)'
      };
      priceSource = sourceLabels[pricing.cardmarket.source] || 'Cardmarket';
    }
    if (!bestPrice && pricing.justtcg?.price_eur) {
      bestPrice = pricing.justtcg.price_eur;
      priceSource = `JustTCG $${pricing.justtcg.price_usd.toFixed(2)} → €${bestPrice.toFixed(2)} (${pricing.justtcg.condition_full})`;
    }
    if (!bestPrice && pricing.tcgplayer?.price) {
      bestPrice = Math.round(pricing.tcgplayer.price * USD_TO_EUR * 100) / 100;
      const src = pricing.tcgplayer.source === 'justtcg' ? 'JustTCG' : 'TCGPlayer';
      priceSource = `${src} $${pricing.tcgplayer.price.toFixed(2)} → €${bestPrice.toFixed(2)}`;
    }
    if (!bestPrice && pricing.ebay?.median_price) {
      bestPrice = pricing.ebay.median_price;
      priceCurrency = pricing.ebay.currency || 'EUR';
      priceSource = `eBay sold median`;
    }

    if (bestPrice) {
      // Graded cards: skip the condition multiplier — the grade IS the condition.
      const effectiveMult = isGraded ? 1.0 : conditionMult;
      const adjustedPrice = bestPrice * effectiveMult;
      const condLabel = isGraded
        ? `${card.graded.company} ${card.graded.grade}`
        : (card.condition_estimate || 'NM');
      pricing.buy_price = {
        suggested: Math.round(adjustedPrice * buyPercentage * 100) / 100,
        market_value: bestPrice,
        condition_adjusted: Math.round(adjustedPrice * 100) / 100,
        currency: priceCurrency,
        formula: `${bestPrice.toFixed(2)}€ × ${effectiveMult} (${condLabel}) × ${(buyPercentage * 100).toFixed(0)}% = ${(Math.round(adjustedPrice * buyPercentage * 100) / 100).toFixed(2)}€`,
        price_source: priceSource,
        graded: isGraded ? card.graded : null
      };
    }

    // ── HOTNESS SCORE ──
    // Combines price trend (7d vs 30d) + eBay sales volume into a
    // 0–100 score with a label: "hot" / "warm" / "steady" / "slow".
    // Helps Dave prioritise which cards to buy for quick resale.
    const hotness = { score: 50, label: 'steady', trend: null, volume: null, reasons: [] };

    // 1. PRICE TREND — compare 7-day avg to 30-day avg (from TCGGO)
    const rcm = pricing.rapidapi_cm || {};
    if (rcm.avg7 && rcm.avg30 && rcm.avg30 > 0) {
      const trendPct = ((rcm.avg7 - rcm.avg30) / rcm.avg30) * 100;
      hotness.trend = Math.round(trendPct * 10) / 10; // e.g. +12.3%
      // Trend scoring: +15% or more = very hot, +5% = warm, -5% = cooling
      if (trendPct >= 15)       { hotness.score += 30; hotness.reasons.push(`Price up ${hotness.trend}% (7d vs 30d)`); }
      else if (trendPct >= 5)   { hotness.score += 15; hotness.reasons.push(`Price up ${hotness.trend}%`); }
      else if (trendPct >= 0)   { hotness.score += 5;  hotness.reasons.push(`Price stable (+${hotness.trend}%)`); }
      else if (trendPct >= -5)  { hotness.score -= 5;  hotness.reasons.push(`Price dipping ${hotness.trend}%`); }
      else                      { hotness.score -= 15; hotness.reasons.push(`Price falling ${hotness.trend}%`); }
    }
    // Fallback: JustTCG 30d price change
    else if (pricing.justtcg?.price_change_30d) {
      const chg = pricing.justtcg.price_change_30d;
      hotness.trend = Math.round(chg * 10) / 10;
      if (chg >= 10)      { hotness.score += 20; hotness.reasons.push(`Price up ${hotness.trend}% (30d)`); }
      else if (chg >= 0)  { hotness.score += 5; }
      else                { hotness.score -= 10; hotness.reasons.push(`Price down ${hotness.trend}% (30d)`); }
    }

    // 2. SALES VOLUME — eBay sold listing count
    const ebayCount = pricing.ebay?.sample_size || 0;
    hotness.volume = ebayCount;
    if (ebayCount >= 12)      { hotness.score += 20; hotness.reasons.push(`${ebayCount} recent eBay sales`); }
    else if (ebayCount >= 6)  { hotness.score += 10; hotness.reasons.push(`${ebayCount} eBay sales`); }
    else if (ebayCount >= 3)  { hotness.score += 5; }
    else if (ebayCount === 0) { hotness.score -= 10; hotness.reasons.push('No recent eBay sales'); }

    // 3. VALUE BONUS — high-value cards (€5+) with good trend are better inventory
    if (bestPrice && bestPrice >= 10 && hotness.trend && hotness.trend > 0) {
      hotness.score += 10;
      hotness.reasons.push(`High-value card (${bestPrice.toFixed(2)}€)`);
    } else if (bestPrice && bestPrice < 1) {
      hotness.score -= 10; // bulk-bin cards are slow movers
    }

    // Clamp and label
    hotness.score = Math.max(0, Math.min(100, hotness.score));
    if (hotness.score >= 75)      hotness.label = 'hot';
    else if (hotness.score >= 60) hotness.label = 'warm';
    else if (hotness.score >= 40) hotness.label = 'steady';
    else                          hotness.label = 'slow';

    pricing.hotness = hotness;
    console.log(`[HOTNESS] ${card.name}: ${hotness.score}/100 (${hotness.label}) — ${hotness.reasons.join('; ') || 'default'}`);

    res.json(pricing);
  } catch (err) {
    console.error('Pricing error:', err.message);
    res.status(500).json({ error: 'Pricing lookup failed', details: err.message });
  }
});


// ============================================================
// MANUAL SEARCH
// ============================================================
app.get('/api/search', async (req, res) => {
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

    // For other TCGs, provide Cardmarket search link
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


// ============================================================
// HEALTH CHECK
// ============================================================
// Health endpoint — used by the client to show API status, and by UptimeRobot
// (or any uptime pinger) to keep the Render free-tier dyno warm.
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ts: Date.now(),
    uptime: process.uptime(),
    apis: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      cardmarket: '✅ Direct links + API prices (no scraping)',
      ebay: !!(process.env.EBAY_APP_ID && process.env.EBAY_CERT_ID),
      scryfall: true,
      pokemontcg: true
    }
  });
});

// =========================================================
// ROOM-BASED SYNC (phone → laptop live scan push via SSE)
// =========================================================
// rooms: { roomId: { listeners: Set<res>, history: Array<{event}> } }
const rooms = new Map();
function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { listeners: new Set(), history: [] });
  return rooms.get(id);
}

// Phone (or any client) pushes a scanned card to the room
app.post('/api/room/:id/scan', (req, res) => {
  const room = getRoom(req.params.id);
  const payload = req.body || {};
  const msg = JSON.stringify({ type: 'scan', entry: payload, ts: Date.now() });
  room.history.push(msg);
  if (room.history.length > 500) room.history.shift();
  for (const client of room.listeners) {
    try { client.write(`data: ${msg}\n\n`); } catch (e) {}
  }
  res.json({ ok: true, listeners: room.listeners.size });
});

// Laptop (host) subscribes via SSE to receive scans live
app.get('/api/room/:id/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  const room = getRoom(req.params.id);
  room.listeners.add(res);
  res.write(`data: ${JSON.stringify({ type: 'hello', roomId: req.params.id, ts: Date.now() })}\n\n`);
  // Keep-alive ping every 25s
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) {}
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    room.listeners.delete(res);
  });
});

// Optional: laptop pulls recent history (in case SSE dropped)
app.get('/api/room/:id/history', (req, res) => {
  const room = getRoom(req.params.id);
  res.json({ history: room.history.slice(-50).map(s => JSON.parse(s)) });
});

// ============================================================
// PUBLIC CUSTOMER QUOTE TOOL — /quote
// ============================================================
// Standalone customer-facing page for bulk indicative pricing.
// Shares the /api/identify-stream + /api/price backend.
app.get('/quote', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'quote.html'));
});

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Lead capture — customer submits their email + card list, we email them a
// quote and ping the shop. Uses Brevo transactional API (no new deps).
app.post('/api/quote-lead', quoteLeadLimiter, async (req, res) => {
  try {
    const { email, name, newsletter, cards, totals, cashPct, creditPct } = req.body || {};
    if (!email || !cards || !Array.isArray(cards) || !cards.length) {
      return res.status(400).json({ error: 'email and cards required' });
    }
    // Basic email shape check (server-side defence; client also validates).
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'invalid email' });
    }
    // Cap at 20 as a server-side guard (client also caps).
    const trimmed = cards.slice(0, 20);

    const SHOP_EMAIL = process.env.SHOP_EMAIL || 'dave@boardandbrewed.ie';
    const SHOP_NAME = process.env.SHOP_NAME || 'Board & Brewed';
    const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || SHOP_EMAIL;

    // Build card rows. Customer email gets rows without photos; shop email
    // gets a separate rows variant that references attached photo filenames.
    const rowsPlain = trimmed.map(c => {
      const cash = (c.cash_offer ?? 0).toFixed(2);
      const credit = (c.credit_offer ?? 0).toFixed(2);
      const mv = (c.market_value ?? 0).toFixed(2);
      return `<tr>
        <td style="padding:8px; border-bottom:1px solid #eee;">${escapeHtml(c.name || 'Unknown')}${c.set_code ? ' <span style="color:#888;">(' + escapeHtml(c.set_code) + ')</span>' : ''}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">€${mv}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; color:#f59e0b;">€${cash}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; color:#22c55e;">€${credit}</td>
      </tr>`;
    }).join('');
    const rows = rowsPlain;

    // Extract photo dataUrls → Brevo attachments (base64, strip header).
    // Skip any that are missing or malformed. Cap at ~9MB total just in case.
    const attachments = [];
    let totalBytes = 0;
    trimmed.forEach((c, i) => {
      if (!c.photo || typeof c.photo !== 'string' || !c.photo.startsWith('data:image/')) return;
      const commaIdx = c.photo.indexOf(',');
      if (commaIdx < 0) return;
      const b64 = c.photo.slice(commaIdx + 1);
      const estBytes = Math.floor(b64.length * 0.75);
      if (totalBytes + estBytes > 9 * 1024 * 1024) return; // respect Brevo limit
      totalBytes += estBytes;
      // Try to keep the card name in the filename for quick triage
      const safeName = (c.name || 'card').replace(/[^a-z0-9_\-]+/gi, '_').slice(0, 30);
      attachments.push({
        name: `${String(i + 1).padStart(2, '0')}-${safeName}.jpg`,
        content: b64
      });
    });

    const customerHtml = `
      <div style="font-family:-apple-system,system-ui,sans-serif; max-width:640px; margin:0 auto; padding:24px; color:#222;">
        <h2 style="color:#1a1a1a; margin-bottom:4px;">Your ${SHOP_NAME} Quote</h2>
        <p style="color:#666; margin-top:0;">Hi${name ? ' ' + escapeHtml(name) : ''}, here's an indicative price for the cards you sent over. Final offer depends on condition verified in-store.</p>
        <table style="width:100%; border-collapse:collapse; margin:16px 0;">
          <thead><tr style="background:#f5f5f5;">
            <th style="padding:8px; text-align:left;">Card</th>
            <th style="padding:8px; text-align:right;">Market</th>
            <th style="padding:8px; text-align:right;">Cash offer</th>
            <th style="padding:8px; text-align:right;">Credit offer</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr style="font-weight:700; background:#fafafa;">
            <td style="padding:8px;">Totals (${trimmed.length} card${trimmed.length !== 1 ? 's' : ''})</td>
            <td style="padding:8px; text-align:right;">€${(totals?.market || 0).toFixed(2)}</td>
            <td style="padding:8px; text-align:right; color:#f59e0b;">€${(totals?.cash || 0).toFixed(2)}</td>
            <td style="padding:8px; text-align:right; color:#22c55e;">€${(totals?.credit || 0).toFixed(2)}</td>
          </tr></tfoot>
        </table>
        <p style="font-size:13px; color:#666;">Cash offer: ${cashPct || 55}% of market value. Store credit: ${creditPct || 70}% of market value. Condition-adjusted.</p>
        <p style="margin-top:24px;">Bring your cards to the shop or reply to this email to arrange drop-off. We'll give you a firm offer once we grade condition.</p>
        <p style="color:#888; font-size:12px; margin-top:32px;">${SHOP_NAME}</p>
      </div>`;

    const shopHtml = `
      <div style="font-family:sans-serif;">
        <h3>New quote request</h3>
        <p><b>Email:</b> ${escapeHtml(email)}${name ? ' &middot; <b>Name:</b> ' + escapeHtml(name) : ''}${newsletter ? ' &middot; <b>Newsletter:</b> YES' : ''}</p>
        <p><b>Totals:</b> Market €${(totals?.market || 0).toFixed(2)} &middot; Cash €${(totals?.cash || 0).toFixed(2)} &middot; Credit €${(totals?.credit || 0).toFixed(2)}</p>
        <p style="color:#666; font-size:13px;">${attachments.length} card photo${attachments.length !== 1 ? 's' : ''} attached.</p>
        <table style="width:100%; border-collapse:collapse;">
          <thead><tr><th align="left">#</th><th align="left">Card</th><th align="right">MV</th><th align="right">Cash</th><th align="right">Credit</th></tr></thead>
          <tbody>${trimmed.map((c, i) => {
            const cash = (c.cash_offer ?? 0).toFixed(2);
            const credit = (c.credit_offer ?? 0).toFixed(2);
            const mv = (c.market_value ?? 0).toFixed(2);
            return `<tr>
              <td style="padding:8px; border-bottom:1px solid #eee; color:#666;">${String(i+1).padStart(2,'0')}</td>
              <td style="padding:8px; border-bottom:1px solid #eee;">${escapeHtml(c.name || 'Unknown')}${c.set_code ? ' <span style="color:#888;">(' + escapeHtml(c.set_code) + ')</span>' : ''}${c.card_number ? ' <span style="color:#888;">#' + escapeHtml(c.card_number) + '</span>' : ''}${c.condition_estimate ? ' <span style="color:#888;">· ' + escapeHtml(c.condition_estimate) + '</span>' : ''}</td>
              <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">€${mv}</td>
              <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; color:#b45309;">€${cash}</td>
              <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; color:#ca8a04;">€${credit}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;

    // Best-effort send via Brevo. If no API key, just log + return ok so the
    // tool still works during setup — you'll still see the lead server-side.
    if (!process.env.BREVO_API_KEY) {
      console.log('[QUOTE-LEAD] (no BREVO_API_KEY set) would email to', email, 'and', SHOP_EMAIL);
      console.log('[QUOTE-LEAD] payload:', { email, name, newsletter, cardCount: trimmed.length, totals });
      return res.json({ ok: true, emailed: false, note: 'Logged server-side. Set BREVO_API_KEY to enable email.' });
    }

    const sendOne = (toEmail, subject, htmlContent, attachmentsList) => {
      const payload = {
        sender: { name: SHOP_NAME, email: SENDER_EMAIL },
        to: [{ email: toEmail }],
        subject,
        htmlContent
      };
      if (attachmentsList && attachmentsList.length) payload.attachment = attachmentsList;
      return fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      }).then(r => r.ok ? r.json() : r.text().then(t => { throw new Error('Brevo ' + r.status + ': ' + t); }));
    };

    // If the customer opted in, add them to your Brevo newsletter list.
    // Set BREVO_NEWSLETTER_LIST_ID in Render env vars (it's the numeric list ID from Brevo).
    const subscribeIfOptedIn = async () => {
      if (!newsletter) return { subscribed: false };
      const listId = parseInt(process.env.BREVO_NEWSLETTER_LIST_ID || '0', 10);
      if (!listId) {
        console.log('[QUOTE-LEAD] newsletter opt-in but no BREVO_NEWSLETTER_LIST_ID set');
        return { subscribed: false, reason: 'no list configured' };
      }
      try {
        // createContact will add OR update. updateEnabled: true lets us upsert without a 400 if they already exist.
        const res = await fetch('https://api.brevo.com/v3/contacts', {
          method: 'POST',
          headers: {
            'api-key': process.env.BREVO_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            email,
            attributes: name ? { FIRSTNAME: name } : {},
            listIds: [listId],
            updateEnabled: true
          })
        });
        if (!res.ok) {
          const text = await res.text();
          console.warn('[QUOTE-LEAD] newsletter subscribe failed:', res.status, text);
          return { subscribed: false, reason: text };
        }
        return { subscribed: true };
      } catch (e) {
        console.warn('[QUOTE-LEAD] newsletter subscribe error:', e.message);
        return { subscribed: false, reason: e.message };
      }
    };

    const [,, subRes] = await Promise.all([
      sendOne(email, `Your ${SHOP_NAME} card quote`, customerHtml),
      sendOne(SHOP_EMAIL, `New quote request — ${email}${newsletter ? ' (newsletter opt-in)' : ''}`, shopHtml, attachments),
      subscribeIfOptedIn()
    ]);

    res.json({ ok: true, emailed: true, subscribed: subRes.subscribed });
  } catch (e) {
    console.error('[QUOTE-LEAD] failed:', e);
    res.status(500).json({ error: e.message || 'Failed to send quote' });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

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