// apps/server/_legacy-pricing.js
// Owner: A1 | Slice: S5 (transient)
//
// TRANSIENT — slice S6 (A2) moves these into pricing/{adapters,verify,price}.js.
// Until then route handlers import from here. Do NOT add new code in this file.
//
// This is a verbatim extraction of V1 server.js's pricing + identify helpers:
//   - identifyCore + identCache + extractImageBuffer + cacheGet/cacheSet
//   - fixPokemonSuffix + extractPokemonSuffix
//   - verifyCard + per-game verifiers (verifySWU, verifyMagic, verifyPokemon,
//     verifyYuGiOh, verifyGeneric)
//   - scoreCandidate, regMarkMatchesEra, nameMatchesSheet, applyAdditionalsLabel
//   - prefetchRefImage, maybeDoubleCheck, doubleCheckAll, stripInternals
//   - resolveSetCode, lookupTCGdex, lookupViaTCGGO, lookupViaJustTCG
//   - buildCardmarketUrl, fetchCardmarketPrice, fetchJustTCGPrice,
//     fetchRapidAPICardmarketPrice (+ parseJustTCGResult)
//   - priceMagicCard, pricePokemonCard, getEbayToken, priceEbaySold
//   - priceCache (Map LRU 500, 60-min TTL) + key/get/set helpers
//   - PKM_SET_ALIASES, PKM_SET_NAMES, TCGDEX_SET_MAP, POKEMONTCG_UNRELIABLE,
//     REG_MARK_ERAS, POKELLECTOR_CORRECTIONS — verbatim
//   - CARD_ID_SYSTEM_PROMPT — verbatim, ephemeral cache_control intact
//   - USD_TO_EUR (mutable export) + refreshFxRate + boot-time interval
//
// The hardcoded `claude-sonnet-4-6` model strings at three V1 call sites are
// REPLACED by imports from pricing/confidence.js (the only behaviour change
// allowed in S5 — see V2_AUDIT §5.22).

import crypto from 'crypto';
import sharp from 'sharp';
import { axios, anthropic } from './_clients.js';
import {
  IDENT_MODEL,
  READ_SET_CODE_MODEL,
  DOUBLE_CHECK_MODEL,
} from '../../pricing/confidence.js';
import {
  CARD_DB,
  CARD_PRICES,
  addCardToDb,
  lookupLocalDb,
  cacheCardResult,
} from './_card-db-boot.js';

// ============================================================
// USD → EUR (V1 server.js:826-849)
// ============================================================
// Mutable. Re-exported via getter so consumers always read the latest value.
let _usdToEur = 0.92;
export function getUsdToEur() { return _usdToEur; }

async function refreshFxRate() {
  try {
    const resp = await axios.get('https://api.frankfurter.app/latest', {
      params: { from: 'USD', to: 'EUR' },
      timeout: 10000
    });
    const rate = resp.data?.rates?.EUR;
    if (typeof rate === 'number' && rate > 0.5 && rate < 2.0) {
      _usdToEur = rate;
      console.log(`[FX] USD→EUR refreshed: ${rate.toFixed(4)} (frankfurter.app, ${resp.data.date})`);
    } else {
      console.warn(`[FX] Unexpected rate shape — keeping ${_usdToEur}`, rate);
    }
  } catch (e) {
    console.warn(`[FX] Refresh failed — keeping ${_usdToEur}: ${e.message}`);
  }
}
// Wrapped behind a start function so test imports don't leave an open
// interval handle keeping Node alive. The pricing/fx.js extraction will
// supersede this — until then, apps/server/server.js calls it on boot.
export function startLegacyFxRefreshInterval() {
  refreshFxRate();
  return setInterval(refreshFxRate, 24 * 60 * 60 * 1000);
}

// ============================================================
// CARD_ID_SYSTEM_PROMPT (V1 server.js:896-1050)
// ============================================================
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

// ============================================================
// IDENT CACHE (V1 server.js:1058-1075)
// ============================================================
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

// identifyCore — image resize, cache check, Anthropic call, suffix fix.
// V1 server.js:1101-1168.
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

  if (parsed.cards?.length > 0) {
    parsed.cards = parsed.cards.map(card => fixPokemonSuffix(card));
  }
  return { cached: false, parsed, cacheKey, imageBase64: imageData, imageMediaType: optimizedFormat === 'png' ? 'image/png' : 'image/jpeg' };
}

export async function verifyIdentified(cards) {
  if (!cards?.length) return cards || [];
  return Promise.all(cards.map(card => verifyCard(card)));
}

// V1 server.js:1188-1265.
export async function maybeDoubleCheck(userImageBase64, userImageMediaType, card) {
  if (!userImageBase64) return card;
  if (card.game !== 'pokemon') return card;
  if (!card.verified || !card.reference_image) return card;
  if (card.verify_rejected) return card;
  if (card.confidence_score && card.confidence_score >= 200) return card;

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
        timeout: 8000
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
        'set symbol, card number. If unsure, return match:true (we only reject confident mismatches).'
      }],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `Image 1 is the user's scan. Image 2 is the candidate (${card.name} from ${card.set_name || '?'} #${card.card_number || '?'}). Same card printing?` },
          { type: 'image', source: { type: 'base64', media_type: userImageMediaType || 'image/jpeg', data: userImageBase64 } },
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: refBase64 } }
        ]
      }]
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

// ============================================================
// POKEMON SET CODE / NAME / TCGDEX / UNRELIABLE / REG-MARK MAPS
// V1 server.js:1386-1543. Verbatim copy.
// ============================================================
export const PKM_SET_ALIASES = {
  'SVI':  'sv1',        'PAL':  'sv2',        'OBF':  'sv3',
  'MEW':  'sv3pt5',     '151':  'sv3pt5',     'PAR':  'sv4',
  'PAF':  'sv4pt5',     'TEF':  'sv5',        'TWM':  'sv6',
  'SFA':  'sv6pt5',     'SCR':  'sv7',        'SSP':  'sv8',
  'PRE':  'sv8pt5',     'SVE':  'sv8pt5',     'JTG':  'sv9',
  'JT':   'sv9',        'DRI':  'sv10',
  'BBT':  'bbt',        'BLK':  'bbt',        'ZSV10PT5': 'bbt',
  'WHT':  'wht',        'RSV10PT5': 'wht',
  'MEG':  'me1',        'ME1':  'me1',        'PFL':  'me2',
  'ME2':  'me2',        'ASH':  'me2pt5',     'POR':  'me3',
  'ME3':  'me3',
  'SVP':  'svp',        'MEP':  'mep',
  'SSH':  'swsh1',      'RCL':  'swsh2',      'DAA':  'swsh3',
  'VIV':  'swsh4',      'BST':  'swsh5',      'CRE':  'swsh6',
  'EVS':  'swsh7',      'FST':  'swsh8',      'BRS':  'swsh9',
  'ASR':  'swsh10',     'LOR':  'swsh11',     'SIT':  'swsh12',
  'CRZ':  'swsh12pt5',  'CZGG': 'swsh12pt5gg',
  'CPA':  'swsh35',     'SHF':  'swsh45',
  'SWP':  'swshp',      'SWSH': 'swshp',
  'SUM':  'sm1',        'GRI':  'sm2',        'BUS':  'sm3',
  'SLG':  'sm35',       'CIN':  'sm4',        'UPR':  'sm5',
  'FLI':  'sm6',        'CES':  'sm7',        'LOT':  'sm8',
  'TEU':  'sm9',        'UNB':  'sm10',       'UNM':  'sm11',
  'CEC':  'sm12',       'HIF':  'sm35',       'DET':  'det1',
  'XY':   'xy1',        'FLF':  'xy2',        'FFI':  'xy3',
  'PHF':  'xy4',        'PRC':  'xy5',        'ROS':  'xy6',
  'AOR':  'xy7',        'BKT':  'xy8',        'BKP':  'xy9',
  'FCO':  'xy10',       'STS':  'xy11',       'EVO':  'xy12',
  'GEN':  'g1',
};

export const PKM_SET_NAMES = {
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

export const TCGDEX_SET_MAP = {
  'sv1':  'sv01', 'sv2':  'sv02', 'sv3':  'sv03', 'sv3pt5': 'sv03.5',
  'sv4':  'sv04', 'sv4pt5': 'sv04.5', 'sv5':  'sv05', 'sv6':  'sv06',
  'sv6pt5': 'sv06.5', 'sv7':  'sv07', 'sv8':  'sv08', 'sv8pt5': 'sv08.5',
  'sv9':  'sv09', 'sv10': 'sv10',
  'svp':  'svp',  'mep':  'svp',
  'me1':  'sv04.5', 'me2':  'sv05.5', 'me3': 'sv06.5',
  'wht':  'sv10.5', 'bbt':  'sv10.5',
};

export const POKEMONTCG_UNRELIABLE = new Set([
  'mep', 'me1', 'me2pt5', 'wht', 'bbt',
]);

export const REG_MARK_ERAS = {
  'D': { minYear: 2019, maxYear: 2021, prefix: 'swsh' },
  'E': { minYear: 2021, maxYear: 2023, prefix: 'swsh' },
  'F': { minYear: 2022, maxYear: 2024, prefix: 'swsh' },
  'G': { minYear: 2023, maxYear: 2025, prefix: 'sv' },
  'H': { minYear: 2024, maxYear: 2026, prefix: 'sv' },
  'J': { minYear: 2025, maxYear: 2027, prefix: '' },
};

export function regMarkMatchesEra(regMark, d) {
  if (!regMark) return true;
  const era = REG_MARK_ERAS[regMark];
  if (!era) return true;
  const setId = (d.set?.id || '').toLowerCase();
  const releaseYear = d.set?.releaseDate ? parseInt(d.set.releaseDate.substring(0, 4)) : 0;
  const prefixMatch = era.prefix ? setId.startsWith(era.prefix) : true;
  const yearMatch = releaseYear && releaseYear >= era.minYear && releaseYear <= era.maxYear;
  return prefixMatch || yearMatch;
}

export function resolveSetCode(raw) {
  if (!raw) return { setId: null, ptcgoCode: null, aliased: false };
  const upper = String(raw).toUpperCase().trim();
  const lower = String(raw).toLowerCase().trim();
  const mapped = PKM_SET_ALIASES[upper];
  if (mapped) {
    console.log(`[SET-ALIAS] "${upper}" -> set.id "${mapped}"`);
    return { setId: mapped, ptcgoCode: upper, aliased: true };
  }
  return { setId: lower, ptcgoCode: upper, aliased: false };
}

// ============================================================
// FALLBACK LOOKUPS (V1 server.js:2261-2436)
// ============================================================
export async function lookupTCGdex(setId, cardNumber) {
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

export async function lookupViaTCGGO(setId, cardNumber, rawSetCode) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return null;

  const setName = PKM_SET_NAMES[setId];
  const cleanNum = String(cardNumber).replace(/\/.*/, '').replace(/^0+/, '') || String(cardNumber);
  const paddedNum = cleanNum.padStart(3, '0');

  const searchTerms = [];
  if (rawSetCode) searchTerms.push(`${rawSetCode} ${paddedNum}`);
  if (setName) searchTerms.push(`${setName} ${cleanNum}`);
  if (setName) searchTerms.push(`${setName} ${paddedNum}`);
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

      let best = null;
      let bestScore = 0;
      for (const item of data) {
        const itemNum = String(item.card_number || '');
        if (itemNum !== cleanNum && itemNum !== paddedNum && itemNum !== cardNumber) continue;

        let score = 60;
        const epName = (item.episode?.name || '').toLowerCase();
        const epCode = (item.episode?.code || '').toUpperCase();
        if (setName && epName.includes(setName.toLowerCase())) score += 40;
        if (rawSetCode && epCode === rawSetCode.toUpperCase()) score += 50;
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

export async function lookupViaJustTCG(setId, cardNumber) {
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
// SUFFIX FIXER (V1 server.js:3067-3112)
// ============================================================
export function fixPokemonSuffix(card) {
  if (card.game !== 'pokemon') return card;

  const hp = parseInt(card.hp);
  const name = card.name || '';
  const suffix = extractPokemonSuffix(name);

  if (!hp || !suffix) return card;

  let correctedSuffix = suffix;
  let reason = '';

  if (suffix === 'GX' && hp >= 340) {
    correctedSuffix = 'ex';
    reason = `HP ${hp} is too high for GX (max ~270). This is an "ex" card.`;
  }
  if (suffix === 'ex' && hp <= 150) {
    console.log(`[FIX-SUFFIX] Warning: "${name}" has low HP ${hp} for an ex card`);
  }
  if (suffix === 'V' && hp >= 300) {
    correctedSuffix = 'VMAX';
    reason = `HP ${hp} is too high for V (max ~230). This is likely VMAX.`;
  }
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

export function extractPokemonSuffix(name) {
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

// ============================================================
// VERIFY (V1 server.js:3122-3953)
// ============================================================
export async function verifyCard(card) {
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
        verified = await verifyGeneric(card);
        break;
    }

    if (verified) {
      if (card.game === 'pokemon' && card.hp && verified.hp) {
        const aiHp = parseInt(card.hp);
        const dbHp = parseInt(verified.hp);
        if (aiHp && dbHp && Math.abs(aiHp - dbHp) > 20) {
          console.log(`[VERIFY] HP MISMATCH! AI says HP ${aiHp}, DB card "${verified.name}" has HP ${dbHp}. Re-searching...`);
          const baseName = (card.name || '').replace(/\s*(ex|GX|EX|V|VMAX|VSTAR|LV\.X|-GX|-EX)\s*$/, '').replace(/-$/, '').trim();
          let hpMismatchResolved = false;
          try {
            const hpSearch = await axios.get('https://api.pokemontcg.io/v2/cards', {
              params: { q: `name:"${baseName}" hp:${card.hp}`, pageSize: 15 },
              timeout: 10000
            });
            const hpResults = hpSearch.data?.data;
            if (hpResults?.length) {
              let best = null, bestScore = 0;
              for (const d of hpResults) {
                let score = 0;
                if (d.hp === String(card.hp)) score += 50;
                if (card.attacks?.length && d.attacks?.length) {
                  const aiAtks = card.attacks.map(a => (typeof a === 'string' ? a : a.name || '').toLowerCase());
                  const dbAtks = d.attacks.map(a => (a.name || '').toLowerCase());
                  score += aiAtks.filter(a => dbAtks.some(da => da.includes(a) || a.includes(da))).length * 25;
                }
                if (card.attacks?.length && d.abilities?.length) {
                  const aiAbil = card.attacks.map(a => (typeof a === 'string' ? a : '').toLowerCase());
                  const dbAbil = d.abilities.map(a => (a.name || '').toLowerCase());
                  score += aiAbil.filter(a => dbAbil.some(da => da.includes(a) || a.includes(da))).length * 25;
                }
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
                const hpRefUrl = best.images?.large || best.images?.small;
                verified = {
                  name: best.name,
                  set_name: best.set?.name,
                  set_code: best.set?.id?.toUpperCase(),
                  card_number: best.number,
                  rarity: best.rarity,
                  hp: best.hp,
                  image: hpRefUrl,
                  source: 'pokemontcg.io (HP re-search)',
                  _refImagePromise: prefetchRefImage(hpRefUrl)
                };
                hpMismatchResolved = true;
              }
            }
          } catch (hpErr) {
            console.error(`[VERIFY] HP re-search failed: ${hpErr.message}`);
          }

          if (!hpMismatchResolved) {
            console.log(`[VERIFY] REJECTED — HP mismatch unresolved. Keeping AI identification as-is.`);
            return { ...card, verified: false, verify_rejected: 'hp_mismatch' };
          }
        }
      }

      console.log(`[VERIFY] CORRECTED -> "${verified.name}" from ${verified.set_name} (${verified.set_code}) #${verified.card_number}`);
      return {
        ...card,
        name: verified.name || card.name,
        set_name: verified.set_name || card.set_name,
        set_code: verified.set_code || card.set_code,
        card_number: verified.card_number || card.card_number,
        rarity: verified.rarity || card.rarity,
        reference_image: verified.image || null,
        cardmarket_url: verified.cardmarket_url || null,
        tcgplayer_url: verified.tcgplayer_url || null,
        verified: true,
        db_source: verified.source,
        confidence_score: verified.confidence_score || null,
        candidates: verified.candidates || null,
        _refImagePromise: verified._refImagePromise || null
      };
    } else {
      console.log(`[VERIFY] Could not verify — using AI identification as-is`);
    }
  } catch (err) {
    console.error(`[VERIFY] Error: ${err.message}`);
  }

  return { ...card, verified: false };
}

async function verifySWU(card) {
  try {
    const searchUrl = `https://api.swu-db.com/cards/search?q=${encodeURIComponent(card.name)}`;
    console.log(`[VERIFY-SWU] Searching: ${searchUrl}`);

    const resp = await axios.get(searchUrl, { timeout: 8000 });
    const results = resp.data?.data || resp.data;

    if (Array.isArray(results) && results.length > 0) {
      let best = null;
      let bestScore = -1;

      for (const c of results) {
        let score = 0;
        const cName = (c.name || c.Name || '').toLowerCase();
        const cNum = (c.number || c.Number || c.CardNumber || '').toString();
        const cSet = (c.set?.code || c.SetCode || c.set_code || '').toUpperCase();

        if (cName === card.name.toLowerCase()) score += 30;
        else if (cName.includes(card.name.toLowerCase())) score += 15;

        if (card.card_number) {
          const aiNum = card.card_number.replace(/\/.*/, '').replace(/^0+/, '').replace(/^[A-Z]+ ?/, '');
          const dbNum = cNum.replace(/^0+/, '');
          if (aiNum === dbNum) score += 50;
          if (card.card_number.includes(cSet) || card.card_number.toUpperCase().startsWith(cSet)) score += 10;
        }

        if (card.set_code && cSet === card.set_code.toUpperCase()) score += 20;

        if (card.variant && c.variant) {
          if (c.variant.toLowerCase().includes(card.variant.toLowerCase())) score += 15;
        }

        console.log(`[VERIFY-SWU]   "${cName}" ${cSet} #${cNum} => score ${score}`);
        if (score > bestScore) { bestScore = score; best = c; }
      }

      if (!best) best = results[0];

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

async function verifyMagic(card) {
  try {
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

export function nameMatchesSheet(aiName, dbName) {
  const norm = s => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const a = norm(aiName), d = norm(dbName);
  if (!a || !d) return false;
  if (a === d) return true;
  const SUFFIX_RE = /\s*(ex|gx|v|vmax|vstar|lv\.x)\s*$/i;
  const aBase = a.replace(SUFFIX_RE, '').trim();
  const dBase = d.replace(SUFFIX_RE, '').trim();
  if (aBase !== dBase) return false;
  return extractPokemonSuffix(aiName) === extractPokemonSuffix(dbName);
}

export function applyAdditionalsLabel(verified, aiCardNumber) {
  if (!verified || !aiCardNumber || typeof aiCardNumber !== 'string' || !aiCardNumber.includes('/')) return verified;
  const [numStr, totalStr] = aiCardNumber.split('/');
  const num = parseInt(String(numStr || '').replace(/^0+/, '') || '0');
  const total = parseInt(String(totalStr || '').replace(/^0+/, '') || '0');
  if (!num || !total || num <= total) return verified;
  const baseCode = (verified.set_code || '').toUpperCase();
  const baseName = verified.set_name || '';
  return {
    ...verified,
    set_code: baseCode.startsWith('X') ? baseCode : 'X' + baseCode,
    set_name: /additional/i.test(baseName) ? baseName : (baseName ? `${baseName}: Additionals` : baseName),
    _additionals: true
  };
}

export function prefetchRefImage(url) {
  if (!url) return null;
  return axios.get(url, { responseType: 'arraybuffer', timeout: 8000 })
    .catch(e => ({ _failed: e?.message || 'prefetch failed' }));
}

export function scoreCandidate(card, isPromo, d) {
  let score = 0;

  if (d.name?.toLowerCase() === card.name?.toLowerCase()) score += 50;
  else if (d.name?.toLowerCase().includes(card.name?.toLowerCase())) score += 20;

  if (card.hp && d.hp === card.hp) score += 40;
  else if (card.hp && d.hp) {
    const diff = Math.abs(parseInt(d.hp) - parseInt(card.hp));
    if (diff <= 10) score += 20;
  }

  if (card.card_number) {
    const rawAiNum = card.card_number.replace(/\s/g, '');
    const aiNum = rawAiNum.replace(/\/.*/, '').replace(/^0+/, '');
    const dbNum = (d.number || '').replace(/^0+/, '');
    const aiNumNoSV = aiNum.replace(/^SV/, '');
    if (aiNum === dbNum || rawAiNum === d.number) {
      score += 80;
    } else if (aiNumNoSV === dbNum) {
      score += 70;
    } else if (isPromo && aiNum.length > 0 && dbNum.length > 0) {
      score -= 40;
    } else if (aiNum.length > 0 && dbNum.length > 0) {
      score -= 10;
    }
  }

  if (card.attacks?.length && d.abilities?.length) {
    const aiAbilities = card.attacks.map(a => (typeof a === 'string' ? a : '').toLowerCase());
    const dbAbilities = d.abilities.map(a => (a.name || '').toLowerCase());
    const abilityMatches = aiAbilities.filter(a => dbAbilities.some(da => da.includes(a) || a.includes(da)));
    score += abilityMatches.length * 15;
  }

  if (card.card_number && card.card_number.includes('/')) {
    const aiSetTotal = parseInt(card.card_number.split('/')[1]?.replace(/^0+/, '') || '0');
    const dbSetTotal = parseInt(d.set?.printedTotal || d.set?.total || '0');
    if (aiSetTotal && dbSetTotal) {
      if (aiSetTotal === dbSetTotal) {
        score += 50;
      } else {
        const diff = Math.abs(aiSetTotal - dbSetTotal);
        if (diff <= 2) score += 20;
        else if (diff <= 10) score -= 30;
        else score -= 80;
      }
    }
  }

  if (card.set_code && d.set?.id?.toUpperCase() === card.set_code.toUpperCase()) score += 25;
  if (card.set_name && d.set?.name) {
    const aiSet = card.set_name.toLowerCase().replace(/^ex\s+/i, '');
    const dbSet = d.set.name.toLowerCase().replace(/^ex\s+/i, '');
    if (aiSet === dbSet) score += 25;
    else if (dbSet.includes(aiSet) || aiSet.includes(dbSet)) score += 15;
  }

  if (card.attacks?.length && d.attacks?.length) {
    const aiAttacks = card.attacks.map(a => (typeof a === 'string' ? a : a.name || '').toLowerCase());
    const dbAttacks = d.attacks.map(a => (a.name || '').toLowerCase());
    const matches = aiAttacks.filter(a => dbAttacks.some(da => da.includes(a) || a.includes(da)));
    score += matches.length * 15;
  }

  const aiSuffix = extractPokemonSuffix(card.name);
  const dbSuffix = extractPokemonSuffix(d.name);
  if (aiSuffix && dbSuffix && aiSuffix === dbSuffix) score += 35;
  else if (aiSuffix && dbSuffix && aiSuffix !== dbSuffix) score -= 50;

  if (card.regulation_mark && !regMarkMatchesEra(card.regulation_mark, d)) {
    score -= 100;
  }

  return score;
}

async function verifyPokemon(card) {
  try {
    if (card.set_code && card.card_number) {
      const resolved = resolveSetCode(card.set_code);
      if (resolved.setId) {
        const cleanNum = String(card.card_number).replace(/\/.*/, '').replace(/^0+/, '') || String(card.card_number);
        const local = lookupLocalDb(resolved.setId, cleanNum);
        if (local) {
          const nameOk = nameMatchesSheet(card.name, local.name);
          const aiHp = parseInt(card.hp);
          const dbHp = parseInt(local.hp);
          const hpOk = !aiHp || !dbHp || Math.abs(aiHp - dbHp) <= 20;
          if (nameOk && hpOk) {
            console.log(`[VERIFY-PKM] Local-DB HIT: ${resolved.setId}-${cleanNum} "${local.name}" — skipping pokemontcg.io`);
            const localRefUrl = local.reference_image || null;
            const hit = {
              name: local.name,
              set_name: local.set_name,
              set_code: local.set_code,
              card_number: local.card_number,
              rarity: local.rarity,
              hp: local.hp,
              image: localRefUrl,
              cardmarket_url: local.cardmarket_url || null,
              tcgplayer_url: local.tcgplayer_url || null,
              source: `local-db (${local.db_source || 'sheet'})`,
              _refImagePromise: prefetchRefImage(localRefUrl)
            };
            return applyAdditionalsLabel(hit, card.card_number);
          } else {
            console.log(`[VERIFY-PKM] Local-DB entry ${resolved.setId}-${cleanNum} "${local.name}" failed match gate (name=${nameOk}, hp=${hpOk}) — falling through`);
          }
        }
      }
    }

    const isPromo = card.card_number && !card.card_number.includes('/') && /^[A-Z]{2,}P?\d+$/i.test(card.card_number.replace(/\s/g, ''));
    if (isPromo) {
      console.log(`[VERIFY-PKM] Detected PROMO card number: ${card.card_number}`);
    }

    const queries = [];

    if (isPromo) {
      const promoNum = card.card_number.replace(/\s/g, '');
      queries.push(`number:${promoNum}`);
      queries.push(`name:"${card.name}" number:${promoNum}`);
    }

    if (card.attacks?.length) {
      const atk = card.attacks
        .map(a => typeof a === 'string' ? a : (a?.name || ''))
        .find(s => s && s.length > 2);
      if (atk) {
        queries.push(`name:"${card.name}" attacks.name:"${atk.replace(/"/g, '')}"`);
      }
    }

    if (card.card_number?.includes('/')) {
      const total = card.card_number.split('/')[1]?.replace(/^0+/, '');
      const num = card.card_number.split('/')[0].replace(/^0+/, '');
      if (total && num) {
        queries.push(`name:"${card.name}" set.printedTotal:${total} number:${num}`);
      }
    }

    if (card.card_number && card.set_code) {
      const num = card.card_number.replace(/\/.*/, '');
      queries.push(`name:"${card.name}" set.id:${card.set_code.toLowerCase()} number:${num}`);
    }

    if (card.card_number && card.set_name) {
      const num = card.card_number.replace(/\/.*/, '');
      const setName = card.set_name.replace(/^EX\s+/i, '').trim();
      queries.push(`name:"${card.name}" set.name:"*${setName}*" number:${num}`);
      if (card.set_name.toLowerCase().startsWith('ex ')) {
        queries.push(`name:"${card.name}" set.name:"*${card.set_name}*" number:${num}`);
      }
    }

    if (card.card_number) {
      const num = card.card_number.replace(/\/.*/, '');
      queries.push(`name:"${card.name}" number:${num}`);
    }

    if (card.hp) {
      queries.push(`name:"${card.name}" hp:${card.hp}`);
    }

    queries.push(`name:"${card.name}"`);

    let globalBest = null;
    let globalBestScore = -1;
    const seenCardIds = new Set();
    const allScored = [];

    const RACE_THRESHOLD = 220;
    const GRACE_MS = 150;

    const perQueryPromises = queries.map(q =>
      axios.get('https://api.pokemontcg.io/v2/cards', {
        params: { q, pageSize: 20 },
        timeout: 10000
      })
        .then(resp => {
          const results = resp.data?.data || [];
          if (results.length) console.log(`[VERIFY-PKM] "${q}" → ${results.length} results`);
          let queryBestScore = -1;
          for (const d of results) {
            if (seenCardIds.has(d.id)) continue;
            seenCardIds.add(d.id);
            const score = scoreCandidate(card, isPromo, d);
            console.log(`[VERIFY-PKM]   "${d.name}" (${d.set?.name} [${d.set?.printedTotal} cards] #${d.number}, HP:${d.hp}) => score ${score}`);
            allScored.push({ d, score });
            if (score > globalBestScore) {
              globalBestScore = score;
              globalBest = d;
            }
            if (score > queryBestScore) queryBestScore = score;
          }
          return { q, queryBestScore };
        })
        .catch(err => {
          console.error(`[VERIFY-PKM] Query failed "${q}": ${err.message}`);
          return { q, queryBestScore: -1 };
        })
    );

    await new Promise(resolveOuter => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolveOuter(); } };
      perQueryPromises.forEach(p => p.then(r => {
        if (done || !r) return;
        if (r.queryBestScore >= RACE_THRESHOLD) {
          console.log(`[VERIFY-PKM] race trigger: "${r.q}" → ${r.queryBestScore} >= ${RACE_THRESHOLD}, ${GRACE_MS}ms grace`);
          setTimeout(finish, GRACE_MS);
        }
      }));
      Promise.allSettled(perQueryPromises).then(finish);
    });

    const candidates = allScored
      .filter(x => x.score >= 40 && x.d.id !== globalBest?.id)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(({ d, score }) => ({
        name: d.name,
        set_name: d.set?.name || '',
        set_code: d.set?.id?.toUpperCase() || '',
        card_number: d.number || '',
        rarity: d.rarity || '',
        hp: d.hp || '',
        image: d.images?.small || d.images?.large || null,
        cardmarket_url: d.cardmarket?.url || null,
        tcgplayer_url: d.tcgplayer?.url || null,
        score
      }));

    if (globalBest && globalBestScore >= 120) {
      console.log(`[VERIFY-PKM] Best match: "${globalBest.name}" from ${globalBest.set?.name} (score: ${globalBestScore})`);
      const refUrl = globalBest.images?.large || globalBest.images?.small;
      return applyAdditionalsLabel({
        name: globalBest.name,
        set_name: globalBest.set?.name,
        set_code: globalBest.set?.id?.toUpperCase(),
        card_number: globalBest.number,
        rarity: globalBest.rarity,
        hp: globalBest.hp,
        image: refUrl,
        cardmarket_url: globalBest.cardmarket?.url || null,
        tcgplayer_url: globalBest.tcgplayer?.url || null,
        source: 'pokemontcg.io',
        confidence_score: globalBestScore,
        candidates,
        _refImagePromise: globalBestScore < 200 ? prefetchRefImage(refUrl) : null
      }, card.card_number);
    } else if (globalBest) {
      console.log(`[VERIFY-PKM] Best match "${globalBest.name}" scored ${globalBestScore}, below threshold 120 — rejecting.`);
    }

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
            let best = results[0];
            if (card.hp) {
              const hpMatch = results.find(d => d.hp === card.hp || d.hp === String(card.hp));
              if (hpMatch) best = hpMatch;
            }
            console.log(`[VERIFY-PKM] ALT MATCH: "${best.name}" from ${best.set?.name} #${best.number} HP:${best.hp}`);
            const altRefUrl = best.images?.large || best.images?.small;
            return applyAdditionalsLabel({
              name: best.name,
              set_name: best.set?.name,
              set_code: best.set?.id?.toUpperCase(),
              card_number: best.number,
              rarity: best.rarity,
              hp: best.hp,
              image: altRefUrl,
              cardmarket_url: best.cardmarket?.url || null,
              tcgplayer_url: best.tcgplayer?.url || null,
              source: 'pokemontcg.io',
              _refImagePromise: prefetchRefImage(altRefUrl)
            }, card.card_number);
          }
        } catch { /* try next suffix */ }
      }

      try {
        console.log(`[VERIFY-PKM] Last resort: searching base name "${baseName}" with HP ${card.hp}`);
        const hpQuery = card.hp ? ` hp:${card.hp}` : '';
        const resp = await axios.get('https://api.pokemontcg.io/v2/cards', {
          params: { q: `name:"${baseName}"${hpQuery}`, pageSize: 20 },
          timeout: 10000
        });
        const results = resp.data?.data;
        if (results?.length > 0) {
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
            const baseRefUrl = best.images?.large || best.images?.small;
            return applyAdditionalsLabel({
              name: best.name,
              set_name: best.set?.name,
              set_code: best.set?.id?.toUpperCase(),
              card_number: best.number,
              rarity: best.rarity,
              hp: best.hp,
              image: baseRefUrl,
              source: 'pokemontcg.io',
              _refImagePromise: prefetchRefImage(baseRefUrl)
            }, card.card_number);
          }
        }
      } catch { /* give up */ }
    }
  } catch (err) {
    console.error(`[VERIFY-PKM] Error: ${err.message}`);
  }
  return null;
}

async function verifyYuGiOh(card) {
  try {
    const resp = await axios.get('https://db.ygoprodeck.com/api/v7/cardinfo.php', {
      params: { name: card.name },
      timeout: 8000
    });

    if (resp.data?.data?.length > 0) {
      const d = resp.data.data[0];
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

async function verifyGeneric(card) {
  if (card.game === 'onepiece') {
    return null;
  }

  if (card.game === 'lorcana') {
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
// CARDMARKET / PRICING (V1 server.js:3962-5046)
// ============================================================
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

export function getGameSlug(game) {
  return CM_GAME_SLUGS[game] || null;
}

export function buildCardmarketUrl(card) {
  const gameSlug = getGameSlug(card.game);
  const condCode = CONDITION_TO_CM[card.condition_estimate] || 2;

  const num = card.card_number ? card.card_number.replace(/\/.*/, '').replace(/^0+/, '') : '';

  let searchTerm = card.name || '';
  if (num) {
    searchTerm = `${card.name} ${num}`;
  }

  const searchUrl = gameSlug
    ? `https://www.cardmarket.com/en/${gameSlug}/Products/Search?searchString=${encodeURIComponent(searchTerm)}`
    : `https://www.cardmarket.com/en/Search?searchString=${encodeURIComponent(searchTerm)}`;

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

export async function fetchCardmarketPrice(productUrl, condition) {
  if (!productUrl || !productUrl.includes('cardmarket.com')) return null;

  const condCode = CONDITION_TO_CM[condition] || 2;
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

    if (title.includes('Just a moment') || title.includes('Attention') || html.length < 5000) {
      console.log(`[CM-FETCH] Cloudflare blocked (title: "${title}", size: ${html.length})`);
      return null;
    }

    console.log(`[CM-FETCH] Got page! Title: "${title}", size: ${html.length}`);

    const result = { url: productUrl, filtered_url: filteredUrl, source: 'cardmarket_live' };

    const trendMatch = html.match(/Price\s*Trend[\s\S]*?([\d]+[.,][\d]{2})\s*€/i);
    if (trendMatch) result.trend = parseFloat(trendMatch[1].replace(',', '.'));

    const fromMatch = html.match(/(?:From|Ab|Available from)[\s\S]*?([\d]+[.,][\d]{2})\s*€/i);
    if (fromMatch) result.low = parseFloat(fromMatch[1].replace(',', '.'));

    const avg30Match = html.match(/30[- ]day[s]?\s*average[\s\S]*?([\d]+[.,][\d]{2})\s*€/i);
    if (avg30Match) result.avg30 = parseFloat(avg30Match[1].replace(',', '.'));

    const offerPrices = [];
    const priceRegex = /(\d+[.,]\d{2})\s*€/g;
    let match;

    const sellerSection = html.split(/Seller|seller/i)[1] || '';
    while ((match = priceRegex.exec(sellerSection)) !== null) {
      const price = parseFloat(match[1].replace(',', '.'));
      if (price > 0.01 && price < 50000) {
        offerPrices.push(price);
      }
    }

    const uniqueOffers = [...new Set(offerPrices)].sort((a, b) => a - b);

    if (uniqueOffers.length > 0) {
      result.offers_low = uniqueOffers[0];
      result.total_offers = uniqueOffers.length;
      result.note = `Lowest English ${condition}+ offer: ${uniqueOffers[0].toFixed(2)}€ (${uniqueOffers.length} sellers)`;
      console.log(`[CM-FETCH] Found ${uniqueOffers.length} offer prices, lowest: ${uniqueOffers[0]}€`);
    }

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

export async function fetchJustTCGPrice(card) {
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) return null;

  const game = JUSTTCG_GAME_MAP[card.game] || card.game;
  const conditionFull = JUSTTCG_CONDITION_MAP[card.condition_estimate] || 'Near Mint';
  const conditionShort = card.condition_estimate || 'NM';

  try {
    let searchQuery = card.name;
    if (card.card_number) {
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

  const variants = best.variants || [];
  let bestVariant = variants[0];

  const condMatch = variants.filter(v => v.condition === conditionFull);
  if (condMatch.length > 0) {
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
    price_usd: price,
    price_eur: price ? Math.round(price * getUsdToEur() * 100) / 100 : null,
    currency: 'USD',
    last_updated: bestVariant?.lastUpdated ? new Date(bestVariant.lastUpdated * 1000).toISOString() : null,
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

export async function fetchRapidAPICardmarketPrice(card) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) return null;

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
      lowest_nm: cm.lowest_near_mint || null,
      lowest_de: cm.lowest_near_mint_DE || null,
      lowest_fr: cm.lowest_near_mint_FR || null,
      lowest_es: cm.lowest_near_mint_ES || null,
      lowest_it: cm.lowest_near_mint_IT || null,
      avg30: cm['30d_average'] || null,
      avg7: cm['7d_average'] || null,
      graded_psa10: cm.graded?.psa?.psa10 || null,
      graded_psa9: cm.graded?.psa?.psa9 || null,
      graded_cgc10: cm.graded?.cgc?.cgc10 || null,
      tcgplayer_market: tcg.market_price || null,
      tcgplayer_mid: tcg.mid_price || null,
    };

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

export async function priceMagicCard(card) {
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

      const eurPrice = isFoil ? data.prices.eur_foil : data.prices.eur;
      if (eurPrice) {
        prices.cardmarket_price = parseFloat(eurPrice);
        prices.cardmarket_source = 'scryfall.com';
        console.log(`[PRICE] Cardmarket EUR price from Scryfall: ${eurPrice}€ (${data.name})`);
      }
    }

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

export async function pricePokemonCard(card) {
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

      if (d.cardmarket?.prices) {
        const cmPrices = d.cardmarket.prices;
        const isFoil = card.variant && !['normal', 'reverse_holo'].includes(card.variant);

        const cmPrice = isFoil
          ? (cmPrices.reverseHoloLow || cmPrices.reverseHoloTrend || cmPrices.lowPrice || cmPrices.trendPrice)
          : (cmPrices.lowPriceExPlus || cmPrices.lowPrice || cmPrices.trendPrice);

        const cmTrend = cmPrices.trendPrice;

        if (cmPrice) {
          prices.cardmarket_price = cmPrice;
          prices.cardmarket_trend = cmTrend;
          prices.cardmarket_source = 'pokemontcg.io';
          console.log(`[PRICE] Cardmarket from API: lowest=${cmPrice}€, trend=${cmTrend}€ (${d.name} ${d.set?.name} #${d.number})`);
        }

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

export async function priceEbaySold(card) {
  const token = await getEbayToken();
  if (!token) {
    console.log('[eBay] No token available');
    return null;
  }

  const queries = [];

  let specific = card.name;
  if (card.set_code) specific += ` ${card.set_code}`;
  if (card.card_number) specific += ` ${card.card_number.replace(/\/.*/, '')}`;
  queries.push(specific);

  const gameNames = {
    'pokemon': 'pokemon tcg', 'magic': 'mtg', 'starwars': 'star wars unlimited',
    'onepiece': 'one piece tcg', 'yugioh': 'yugioh', 'lorcana': 'lorcana',
    'dragonball': 'dragon ball super', 'digimon': 'digimon tcg', 'fleshandblood': 'flesh and blood'
  };
  if (card.card_number) {
    queries.push(`${card.name} ${card.card_number} ${gameNames[card.game] || ''}`);
  }

  queries.push(`${card.name} ${gameNames[card.game] || 'tcg'} card`);

  const responses = await Promise.all(queries.map(q =>
    axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
      params: {
        q,
        category_ids: '183454',
        filter: 'buyingOptions:{FIXED_PRICE|AUCTION}',
        sort: 'price',
        limit: 15
      },
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_IE'
      },
      timeout: 10000
    })
      .then(resp => ({ q, items: resp.data?.itemSummaries || [] }))
      .catch(err => {
        console.error(`[eBay] API error for "${q}": ${err.response?.data?.errors?.[0]?.message || err.message}`);
        return { q, items: [] };
      })
  ));

  for (const { q, items } of responses) {
    if (!items.length) { console.log(`[eBay] "${q}" → no results`); continue; }
    console.log(`[eBay] "${q}" → ${items.length} listings`);

    const prices = items
      .filter(i => i.price?.value)
      .map(i => ({
        price: parseFloat(i.price.value),
        currency: i.price.currency,
        title: i.title,
        url: i.itemWebUrl
      }))
      .filter(i => i.price > 0 && i.price < 10000)
      .sort((a, b) => a.price - b.price);

    if (!prices.length) continue;
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

  console.log('[eBay] No results found across all search strategies');
  return null;
}

// ============================================================
// PRICE CACHE (V1 server.js:4682-4715)
// ============================================================
const PRICE_CACHE_TTL_MS = 60 * 60 * 1000;
const PRICE_CACHE_MAX = 500;
const priceCache = new Map();

export function priceCacheKey(card, buyPercentage) {
  return [
    card.game || '',
    (card.name || '').toLowerCase(),
    (card.set_code || '').toUpperCase(),
    (card.card_number || '').toString(),
    card.condition_estimate || 'NM',
    card.variant || 'normal',
    card.graded ? `${card.graded.company}-${card.graded.grade}` : '',
    String(buyPercentage)
  ].join('|');
}
export function priceCacheGet(key) {
  const hit = priceCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > PRICE_CACHE_TTL_MS) {
    priceCache.delete(key);
    return null;
  }
  priceCache.delete(key);
  priceCache.set(key, hit);
  return hit.data;
}
export function priceCacheSet(key, data) {
  if (priceCache.size >= PRICE_CACHE_MAX) {
    const first = priceCache.keys().next().value;
    priceCache.delete(first);
  }
  priceCache.set(key, { ts: Date.now(), data });
}

// Re-export the read-set-code model since the route handler uses it.
export { READ_SET_CODE_MODEL };
