import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';
import https from 'https';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
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

app.post('/api/identify', upload.single('image'), async (req, res) => {
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
    const model = isBatchMode
      ? 'claude-sonnet-4-20250514'
      : 'claude-sonnet-4-20250514'; // Sonnet for single-card too — Haiku was misreading card numbers (e.g. 223 → 225) even at higher res. Accuracy > speed.

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
app.post('/api/identify-stream', upload.single('image'), async (req, res) => {
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

    const model = isBatchMode
      ? 'claude-sonnet-4-20250514'
      : 'claude-sonnet-4-20250514'; // Sonnet for single-card too — Haiku was misreading card numbers (e.g. 223 → 225) even at higher res. Accuracy > speed.

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

// Lightweight health endpoint — used by UptimeRobot / any uptime pinger
// to keep the Render free-tier dyno warm (no cold-start wait at card shows).
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), uptime: process.uptime() });
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
  // Mega Evolution sub-sets (ME01/ME02/ME03)
  'MEG':  'me1',        // Mega Evolution (ME01)
  'ME1':  'me1',        // Mega Evolution (ME01 alternate)
  'PFL':  'me2',        // Phantasmal Flames (ME02)
  'ME2':  'me2',        // Phantasmal Flames (ME02 alternate)
  'POR':  'me3',        // Perfect Order (ME03)
  'ME3':  'me3',        // Perfect Order (ME03 alternate)
  // SV promo
  'SVP':  'svp',        // SV Black Star Promos

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
  'CPA':  'swsh35',     // Champion's Path
  'SHF':  'swsh45',     // Shining Fates

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

      // Also try direct card ID lookup: pokemontcg.io stores cards as {setId}-{number}
      // e.g. sv3pt5-151. This is the fastest and most reliable approach.
      if (resolved.setId) {
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
      if (!card) {
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

    res.json({ cards: [card] });
  } catch (err) {
    console.error('[MANUAL] Error:', err.message);
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
    const fs = await import('fs');
    const path = await import('path');
    const logDir = path.join(__dirname, 'logs');
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
    fs.appendFileSync(path.join(logDir, 'bad-ids.log'), JSON.stringify(entry) + '\n');
    console.log(`[BAD-ID] ${entry.card?.name || '?'} — ${entry.reason || '(no reason)'}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[BAD-ID] error:', err.message);
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
    const { number, setCode, game } = req.body || {};
    if (!number || typeof number !== 'string') {
      return res.status(400).json({ error: 'number required' });
    }

    const raw = number.trim();

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
        // Promo-style (e.g. SM211, SWSH066, SVP076) — exact match
        queries.push(`number:"${numPart}"`);
      }

      for (const q of queries) {
        try {
          const resp = await axios.get('https://api.pokemontcg.io/v2/cards', {
            params: { q, pageSize: 5 },
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
// ============================================================
// Cardmarket direct URL builder
// ============================================================
// URL pattern: /en/{Game}/Products/Singles/{Set-Slug}/{Card-Slug}-{CMCode}{Number}
// Example: /en/Pokemon/Products/Singles/Obsidian-Flames/Charizard-ex-OBF125

// Pokemon TCG API set ID -> Cardmarket set code mapping
const POKEMON_CM_SET_CODES = {
  // Scarlet & Violet era
  'sv1': 'SVI', 'sv2': 'PAL', 'sv3': 'OBF', 'sv3pt5': 'MEW',
  'sv4': 'PAR', 'sv4pt5': 'PAF', 'sv5': 'TEF', 'sv6': 'TWM',
  'sv6pt5': 'SFA', 'sv7': 'SSP', 'sv8': 'SCR', 'sv8pt5': 'PRE',
  'svp': 'SVP',
  // Sword & Shield era
  'swsh1': 'SSH', 'swsh2': 'RCL', 'swsh3': 'DAA', 'swsh4': 'VIV',
  'swsh5': 'BST', 'swsh6': 'CRE', 'swsh7': 'EVS', 'swsh8': 'FST',
  'swsh9': 'BRS', 'swsh10': 'ASR', 'swsh11': 'LOR', 'swsh12': 'SIT',
  'swsh12pt5': 'CRZ', 'swshp': 'SWSH',
  // Sun & Moon era
  'sm1': 'SUM', 'sm2': 'GRI', 'sm3': 'BUS', 'sm4': 'CIN',
  'sm5': 'UPR', 'sm6': 'FLI', 'sm7': 'CES', 'sm8': 'LOT',
  'sm9': 'TEU', 'sm10': 'UNB', 'sm11': 'UNM', 'sm12': 'CEC',
  'sm115': 'HIF', 'smp': 'SM',
  // Special sets
  'pgo': 'PGO', 'cel25': 'CEL', 'cel25c': 'CEL',
};

// Cardmarket set URL slug mapping (API set name -> CM slug)
// Most work by just hyphenating, but some need special handling
const POKEMON_CM_SET_SLUGS = {
  'sv1': 'Scarlet-and-Violet', 'sv2': 'Paldea-Evolved', 'sv3': 'Obsidian-Flames',
  'sv3pt5': 'Pokemon-Card-151', 'sv4': 'Paradox-Rift', 'sv4pt5': 'Paldean-Fates',
  'sv5': 'Temporal-Forces', 'sv6': 'Twilight-Masquerade', 'sv6pt5': 'Shrouded-Fable',
  'sv7': 'Stellar-Crown', 'sv8': 'Surging-Sparks', 'sv8pt5': 'Prismatic-Evolutions',
  'svp': 'SV-Black-Star-Promos',
  'sm115': 'Hidden-Fates', 'smp': 'SM-Black-Star-Promos',
  'pgo': 'Pokemon-GO',
};

// MTG: Scryfall provides purchase_uris.cardmarket directly — handled in priceMagicCard

function buildCardmarketUrl(card) {
  const gameSlug = getGameSlug(card.game);
  const condCode = CONDITION_TO_CM[card.condition_estimate] || 2;

  // We no longer guess direct product URLs — Cardmarket's slug rules have too
  // many edge cases (alt-arts, punctuation, variant suffixes) and a guessed
  // URL 404s more often than it works. API-provided URLs (from pokemontcg.io
  // / Scryfall) still override this in the caller when available.

  // Build a narrow, reliable search URL.
  // IMPORTANT: Cardmarket's search treats the query as close to exact-match
  // against the product *name* only — it does NOT search set name or card
  // number. Including either returns "no matches for your query". So we send
  // just the card name (Cardmarket lists every print of that name) and rely
  // on the user to pick the right one from the results list.
  const num = card.card_number ? card.card_number.replace(/\/.*/, '') : '';
  const searchTerm = card.name || '';

  const searchUrl = gameSlug
    ? `https://www.cardmarket.com/en/${gameSlug}/Products/Search?searchString=${encodeURIComponent(searchTerm)}`
    : `https://www.cardmarket.com/en/Search?searchString=${encodeURIComponent(searchTerm)}`;

  // Narrower fallback if the above returns nothing — just name + number
  const narrowTerm = card.name + (num ? ` ${num}` : '');
  const narrowUrl = gameSlug
    ? `https://www.cardmarket.com/en/${gameSlug}/Products/Search?searchString=${encodeURIComponent(narrowTerm)}`
    : `https://www.cardmarket.com/en/Search?searchString=${encodeURIComponent(narrowTerm)}`;

  return {
    product_url: null,
    product_url_filtered: null,
    search_url: searchUrl,
    filtered_search_url: `${searchUrl}&language=1&minCondition=${condCode}`,
    narrow_search_url: narrowUrl,
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
    price_eur: price ? Math.round(price * 0.92 * 100) / 100 : null, // Approximate EUR conversion
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
// USD to EUR approximate conversion (updated periodically)
const USD_TO_EUR = 0.92;

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
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
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

// Lead capture — customer submits their email + card list, we email them a
// quote and ping the shop. Uses Brevo transactional API (no new deps).
app.post('/api/quote-lead', async (req, res) => {
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

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
