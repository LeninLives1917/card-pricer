// pricing/identify-core.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - pricing/confidence.js (IDENT_MODEL, DOUBLE_CHECK_MODEL,
//                            DOUBLE_CHECK_SCORE_GATE)
//   - V1 server.js: identifyCore (1101-1168), maybeDoubleCheck (1188-1265),
//                   doubleCheckAll (1267-1273), stripInternals (1058-1075),
//                   IDENT_CACHE LRU, extractImageBuffer, CARD_ID_SYSTEM_PROMPT
//
// Anthropic-side helpers:
//   - identifyCore: image resize → cache check → Sonnet 4.6 → suffix-fix
//   - maybeDoubleCheck: image-compare gate for low-score verifies
//   - stripInternals: redact `_*` fields before client send (V2_AUDIT §5.10)
//
// IDENT_CACHE invariant: NEVER cache verify_rejected results. The route
// handlers honour this; identifyCore itself just returns the parsed result
// and the cache key.

import crypto from 'crypto';
import sharp from 'sharp';

import { axios, anthropic } from '../apps/server/_clients.js';
import {
  IDENT_MODEL,
  DOUBLE_CHECK_MODEL,
  DOUBLE_CHECK_SCORE_GATE,
} from './confidence.js';
import { fixPokemonSuffix, extractPokemonSuffix } from './adapters/pokemontcg.js';

// Re-export so route handlers / tests can import suffix helpers from here
// without reaching into the Pokemon adapter directly.
export { fixPokemonSuffix, extractPokemonSuffix };

// =============================================================================
// CARD_ID_SYSTEM_PROMPT (V1 server.js:896-1050) — used by /api/identify
// and /api/identify-stream. The `cache_control: ephemeral` marker enables
// Anthropic prompt caching (~10x cost reduction on repeat calls).
// =============================================================================
export const CARD_ID_SYSTEM_PROMPT = `You are an expert trading card identifier with encyclopaedic knowledge of ALL trading card games. You can identify cards with extreme accuracy from:

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
    "regulation_mark": "For Pokemon cards only: the single letter D/E/F/G/H/J printed in a small circle next to the card number. Return exactly that letter, or null if not present/readable.",
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
- REGULATION MARK: Modern Pokémon cards (2019+) show a single letter in a small circle next to the card number at the bottom. It tells us which era/rotation the card is from: D or E = Sword & Shield era, F = SWSH→SV transition, G = Scarlet & Violet mid, H = SV late, J = Mega Evolution era. Report this letter verbatim in the "regulation_mark" field, or null if you can't see it.

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
- FIRST: read the PRINTED SET TOTAL (the number AFTER the "/") from the bottom of the card before you identify the Pokemon. The set total is a near-unique fingerprint: /182 = Destined Rivals, /198 = Paldea Evolved or Scarlet & Violet, /197 = Obsidian Flames, /088 = Perfect Order, /165 = Pokémon 151. Read this FIRST — everything else depends on it. If you can't read the total, say so and set confidence below 0.5.
- READ the EXACT card name as printed — DO NOT guess or use a similar card name
- READ the EXACT suffix: "ex" (lowercase) ≠ "GX" ≠ "EX" (uppercase) ≠ "V" ≠ "VMAX" ≠ "VSTAR". Getting this wrong gives completely wrong prices.
- READ the HP number — this distinguishes card versions (e.g. 330HP vs 250HP Charizard)
- READ the attack names — different versions have different attacks. Include them in the "attacks" array.
- READ the EXACT card number printed on the card — this is the #1 most important field for pricing
  - INCLUDE the full number with set total, e.g. "44/95" not just "44" — the total after "/" identifies which set it belongs to
  - PRESERVE leading zeros EXACTLY as printed. "027" is NOT "27" or "2" — report it as "027". "003/165" must be "003/165", not "3/165". Leading zeros are never decorative; dropping them breaks set lookup.
  - If the printed number is ABOVE the set total (e.g. "229/182"), the card is a Secret Rare / "Additionals" variant — still report the exact number.
  - For EX-era Pokemon cards (2003-2007), the set total is critical because many common Pokemon appear across multiple sets with the same number
  - Example: Psyduck #44 exists in multiple EX-era sets — only the "/95" or "/116" etc. tells us WHICH set
- READ the set symbol carefully — it appears at the bottom right of Pokemon cards and uniquely identifies the set
- If image is blurry, partially obscured, or you're not certain, set confidence below 0.5
- For condition: look for edge whitening, surface scratches, centering issues, corner wear
- NEVER fabricate a card number — if you can't read it clearly, use "" and note why
- If you can identify the game but not the specific card, still set the game field correctly
- Pay close attention to foil/holo patterns visible in the image`;

// =============================================================================
// IDENT CACHE — V1 server.js:1058-1075 — image SHA1 → identify result LRU
// =============================================================================
const IDENT_CACHE_MAX = 100;
const identCache = new Map();

export function cacheGet(key) {
  if (!identCache.has(key)) return null;
  const val = identCache.get(key);
  identCache.delete(key);
  identCache.set(key, val);
  return val;
}

export function cacheSet(key, val) {
  if (identCache.has(key)) identCache.delete(key);
  identCache.set(key, val);
  if (identCache.size > IDENT_CACHE_MAX) {
    const first = identCache.keys().next().value;
    identCache.delete(first);
  }
}

// Test-only accessor — returns true if the cache currently holds an entry for
// `key` without altering LRU order. Prefixed per the _test convention
// (see pricing/phash.js __seedIndex / __resetIndex).
export function _testCacheHas(key) {
  return identCache.has(key);
}

// =============================================================================
// extractImageBuffer — pull raw bytes off either multer file upload OR base64
// data URL body. Throws Error with .status=400 on bad inputs.
// =============================================================================
export function extractImageBuffer(req) {
  if (req.file) return req.file.buffer;
  if (req.body.image) {
    const m = req.body.image.match(/^data:(image\/\w+);base64,(.+)$/);
    if (m) return Buffer.from(m[2], 'base64');
    const err = new Error('Invalid image data');
    err.status = 400;
    throw err;
  }
  const err = new Error('No image provided');
  err.status = 400;
  throw err;
}

// =============================================================================
// identifyCore — image resize + SHA1 cache + Sonnet 4.6 + suffix-fix.
// V1 server.js:1101-1168.
// =============================================================================

/**
 * @param {object} args
 * @param {Buffer} args.buffer  Raw image bytes from multer / base64 body.
 * @param {string} [args.hint]  Optional user-provided hint appended to the
 *                              user message (e.g. game family).
 * @returns {Promise<object>} {cached, result?, parsed?, cacheKey?,
 *                             imageBase64?, imageMediaType?}
 */
export async function identifyCore({ buffer, hint }) {
  const targetSize = 1800;
  const jpegQuality = 92;

  const meta = await sharp(buffer).metadata().catch(() => ({}));
  const srcMax = Math.max(meta.width || 0, meta.height || 0);
  const passthroughOk = (meta.format === 'jpeg' || meta.format === 'png')
    && srcMax > 0 && srcMax <= targetSize;
  const optimized = passthroughOk
    ? buffer
    : await sharp(buffer)
        .resize(targetSize, targetSize, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: jpegQuality })
        .toBuffer();
  const optimizedFormat = passthroughOk ? meta.format : 'jpeg';
  const imageData = optimized.toString('base64');

  let cacheKey = null;
  if (!hint) {
    cacheKey = crypto.createHash('sha1').update(optimized).digest('hex');
    const hit = cacheGet(cacheKey);
    if (hit) return { cached: true, result: hit, cacheKey };
  }

  let userMessage = 'Identify this trading card. FIRST read the card number at the bottom of the card — this is the most critical field. If it has no slash (like SM211, SWSH066) it is a PROMO card. Be extremely precise with the set code and card number.';
  if (hint) userMessage += `\n\nUser hint: ${hint}`;

  const response = await anthropic.messages.create({
    model: IDENT_MODEL,
    max_tokens: 1024,
    system: [{ type: 'text', text: CARD_ID_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: optimizedFormat === 'png' ? 'image/png' : 'image/jpeg', data: imageData } },
        { type: 'text', text: userMessage },
      ],
    }],
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

  if (parsed.cards?.length > 0) {
    parsed.cards = parsed.cards.map(card => fixPokemonSuffix(card));
  }
  return { cached: false, parsed, cacheKey, imageBase64: imageData, imageMediaType: optimizedFormat === 'png' ? 'image/png' : 'image/jpeg' };
}

// =============================================================================
// maybeDoubleCheck — V1 server.js:1188-1265 — image-compare gate via Sonnet 4.6.
//
// Skipped when:
//   - card.confidence_score >= DOUBLE_CHECK_SCORE_GATE (high-trust verify)
//   - non-Pokemon (V1 invariant)
//   - card already verify_rejected (don't compound)
//   - no reference_image
// =============================================================================
export async function maybeDoubleCheck(userImageBase64, userImageMediaType, card) {
  if (!userImageBase64) return card;
  if (card.game !== 'pokemon') return card;
  if (!card.verified || !card.reference_image) return card;
  if (card.verify_rejected) return card;
  if (card.confidence_score && card.confidence_score >= DOUBLE_CHECK_SCORE_GATE) return card;

  try {
    let refResp;
    if (card._refImagePromise) {
      refResp = await card._refImagePromise;
      if (refResp && refResp._failed) {
        console.warn(`[DOUBLE-CHECK] prefetch failed for "${card.name}": ${refResp._failed}`);
        return card;
      }
    } else {
      refResp = await axios.get(card.reference_image, {
        responseType: 'arraybuffer',
        timeout: 8000,
      });
    }
    const refBase64 = Buffer.from(refResp.data).toString('base64');
    const mediaType = /\.png($|\?)/i.test(card.reference_image) ? 'image/png'
                    : /\.jpe?g($|\?)/i.test(card.reference_image) ? 'image/jpeg'
                    : /\.webp($|\?)/i.test(card.reference_image) ? 'image/webp'
                    : 'image/png';

    const resp = await anthropic.messages.create({
      model: DOUBLE_CHECK_MODEL,
      max_tokens: 150,
      system: [{ type: 'text', text:
        'You compare two trading-card images and decide if they show the SAME printing. ' +
        'Respond with ONLY JSON: {"match": true|false, "reason": "short phrase"}. ' +
        'A match means same card name, same set, and same art/foil/border variant. ' +
        'Different printings of the same Pokemon (base vs reverse holo vs secret rare vs ' +
        'alt art vs wrong era) are NOT matches — look at art, border, foil pattern, ' +
        'set symbol, card number. If unsure, return match:true (we only reject confident mismatches).',
      }],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `Image 1 is the user's scan. Image 2 is the candidate (${card.name} from ${card.set_name || '?'} #${card.card_number || '?'}). Same card printing?` },
          { type: 'image', source: { type: 'base64', media_type: userImageMediaType || 'image/jpeg', data: userImageBase64 } },
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: refBase64 } },
        ],
      }],
    });

    const text = resp.content?.[0]?.text || '';
    let result = null;
    try { result = JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { result = JSON.parse(m[0]); } catch {} }
    }
    if (!result || typeof result.match !== 'boolean') {
      console.warn(`[DOUBLE-CHECK] unparseable response for "${card.name}":`, text.slice(0, 120));
      return card;
    }
    if (result.match === false) {
      console.log(`[DOUBLE-CHECK] REJECTED "${card.name}" — ${result.reason || '(no reason)'}`);
      return { ...card, verified: false, verify_rejected: 'double_check_mismatch', double_check_reason: result.reason || null };
    }
    console.log(`[DOUBLE-CHECK] CONFIRMED "${card.name}"`);
    return card;
  } catch (e) {
    console.warn(`[DOUBLE-CHECK] failed for "${card.name}": ${e.message}`);
    return card;
  }
}

export async function doubleCheckAll(userImageBase64, userImageMediaType, cards) {
  if (!cards?.length) return cards || [];
  return Promise.all(cards.map(c => maybeDoubleCheck(userImageBase64, userImageMediaType, c)));
}

/**
 * Strip every key that begins with `_` before sending to the client.
 * Single source of truth for the V2_AUDIT §5.10 invariant — `_refImagePromise`
 * (an in-flight axios Promise) MUST NOT leak to JSON.stringify or the
 * response hangs / errors / leaks memory.
 */
export function stripInternals(cards) {
  if (!cards?.length) return cards || [];
  return cards.map(c => {
    if (!c || typeof c !== 'object') return c;
    const out = {};
    for (const k of Object.keys(c)) {
      if (k.startsWith('_')) continue;
      out[k] = c[k];
    }
    return out;
  });
}
