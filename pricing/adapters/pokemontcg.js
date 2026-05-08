// pricing/adapters/pokemontcg.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - pricing/adapter.interface.md (verify + price for game='pokemon')
//   - pricing/confidence.js (RACE_THRESHOLD, RACE_GRACE_MS, MIN_ACCEPT_SCORE,
//                            HP_MISMATCH_TOLERANCE, DOUBLE_CHECK_SCORE_GATE,
//                            SCORE_WEIGHTS)
//   - V1 server.js: verifyPokemon (race+grace+threshold), scoreCandidate,
//                   pricePokemonCard, applyAdditionalsLabel,
//                   prefetchRefImage, nameMatchesSheet, extractPokemonSuffix
//
// VERBATIM extraction with three behaviour-preserving deltas (see header of
// pricing/verify.js): race threshold + accept floor + score gate are imported
// from confidence.js instead of being inlined. Weights are imported from
// confidence.js's exported SCORE_WEIGHTS — the only S6-allowed change vs V1.
//
// Tied regression tests: RG-08, RG-09, RG-28, RG-29, RG-10, RG-11.

import { axios } from '../../apps/server/_clients.js';
import {
  lookupLocalDb,
  cacheCardResult,
} from '../../apps/server/_card-db-boot.js';
import {
  RACE_THRESHOLD,
  RACE_GRACE_MS,
  MIN_ACCEPT_SCORE,
  HP_MISMATCH_TOLERANCE,
  DOUBLE_CHECK_SCORE_GATE,
  SCORE_WEIGHTS,
} from '../confidence.js';
import { regMarkMatchesEra } from '../corrections.js';
import { resolveSetCode } from '../set-aliases.js';

const NAME = 'pokemontcg.io';

// =============================================================================
// Suffix helpers (V1 server.js:3164-3174 + 3138-3162)
// =============================================================================

/**
 * Extract the trailing Pokemon name suffix (ex/GX/V/VMAX/VSTAR/EX/LV.X) or
 * null. Lowercase 'ex' (SV era) is intentionally distinct from uppercase
 * 'EX' (XY era). V1 server.js:3164.
 */
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

/**
 * Repair AI-mis-suffix-ed names where HP rules out the suffix Sonnet 4.6
 * picked. V1 server.js:3138-3162. Catches:
 *   - GX with HP ≥ 340 → ex (HP too high for GX)
 *   - V  with HP ≥ 300 → VMAX
 *   - VMAX with HP < 280 → V
 * Returns the original card object on no-op (so it's safe to map over).
 */
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

// =============================================================================
// Local-DB short-circuit gates (V1 server.js:3494-3499 nameMatchesSheet)
// =============================================================================

/**
 * Strict name-comparison helper for the local-DB short-circuit. Treats names
 * as equal iff base-name + suffix both match. Used to gate
 * `lookupLocalDb` hits before bypassing pokemontcg.io.
 */
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

// =============================================================================
// Additionals label (V1 server.js:3520)
// =============================================================================

/**
 * When the printed card_number > set_total (e.g. "199/197"), Cardmarket
 * prefixes the set code with 'X' and labels the entry "X<code>: Additionals".
 * This helper applies that prefix on the verify result so the eventual
 * Cardmarket URL points at the right product page.
 */
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
    _additionals: true,
  };
}

/**
 * Prefetch the reference image so maybeDoubleCheck doesn't pay a second
 * download. Returns an in-flight Promise<axios.Response<ArrayBuffer>>.
 * On error, resolves to a `_failed`-tagged sentinel (the double-check
 * swallows it and returns the card unchanged).
 */
export function prefetchRefImage(url) {
  if (!url) return null;
  return axios.get(url, { responseType: 'arraybuffer', timeout: 8000 })
    .catch(e => ({ _failed: e?.message || 'prefetch failed' }));
}

// =============================================================================
// scoreCandidate (V1 server.js:3413, hoisted weights)
// =============================================================================

/**
 * Score a pokemontcg.io candidate row against an AI-identified card.
 * Pure function — no side effects, no I/O. Inputs are independent so
 * the weights table can be swapped at test time.
 *
 * @param {object} card     PartialCard from /api/identify (game='pokemon').
 * @param {boolean} isPromo Whether the card_number looks promo-shaped.
 * @param {object} d        pokemontcg.io card row.
 * @param {object} [weights] Override weights table; defaults to SCORE_WEIGHTS.
 * @returns {number} Cumulative score. RACE_THRESHOLD / MIN_ACCEPT_SCORE
 *                   interpret this directly.
 */
export function scoreCandidate(card, isPromo, d, weights = SCORE_WEIGHTS) {
  let score = 0;
  const W = weights;

  if (d.name?.toLowerCase() === card.name?.toLowerCase()) score += W.NAME_EXACT;
  else if (d.name?.toLowerCase().includes(card.name?.toLowerCase())) score += W.NAME_SUBSTRING;

  if (card.hp && d.hp === card.hp) score += W.HP_EXACT;
  else if (card.hp && d.hp) {
    const diff = Math.abs(parseInt(d.hp) - parseInt(card.hp));
    if (diff <= 10) score += W.HP_NEAR;
  }

  if (card.card_number) {
    const rawAiNum = card.card_number.replace(/\s/g, '');
    const aiNum = rawAiNum.replace(/\/.*/, '').replace(/^0+/, '');
    const dbNum = (d.number || '').replace(/^0+/, '');
    const aiNumNoSV = aiNum.replace(/^SV/, '');
    if (aiNum === dbNum || rawAiNum === d.number) {
      score += W.NUMBER_EXACT;
    } else if (aiNumNoSV === dbNum) {
      score += W.NUMBER_SV_STRIPPED;
    } else if (isPromo && aiNum.length > 0 && dbNum.length > 0) {
      score += W.NUMBER_PROMO_MISMATCH;
    } else if (aiNum.length > 0 && dbNum.length > 0) {
      score += W.NUMBER_MISMATCH;
    }
  }

  if (card.attacks?.length && d.abilities?.length) {
    const aiAbilities = card.attacks.map(a => (typeof a === 'string' ? a : '').toLowerCase());
    const dbAbilities = d.abilities.map(a => (a.name || '').toLowerCase());
    const abilityMatches = aiAbilities.filter(a => dbAbilities.some(da => da.includes(a) || a.includes(da)));
    score += abilityMatches.length * W.ABILITY_PER_MATCH;
  }

  if (card.card_number && card.card_number.includes('/')) {
    const aiSetTotal = parseInt(card.card_number.split('/')[1]?.replace(/^0+/, '') || '0');
    const dbSetTotal = parseInt(d.set?.printedTotal || d.set?.total || '0');
    if (aiSetTotal && dbSetTotal) {
      if (aiSetTotal === dbSetTotal) {
        score += W.SET_TOTAL_EXACT;
      } else {
        const diff = Math.abs(aiSetTotal - dbSetTotal);
        if (diff <= 2) score += W.SET_TOTAL_NEAR;
        else if (diff <= 10) score += W.SET_TOTAL_DIFF_MEDIUM;
        else score += W.SET_TOTAL_DIFF_LARGE;
      }
    }
  }

  if (card.set_code && d.set?.id?.toUpperCase() === card.set_code.toUpperCase()) score += W.SET_CODE_MATCH;
  if (card.set_name && d.set?.name) {
    const aiSet = card.set_name.toLowerCase().replace(/^ex\s+/i, '');
    const dbSet = d.set.name.toLowerCase().replace(/^ex\s+/i, '');
    if (aiSet === dbSet) score += W.SET_NAME_EXACT;
    else if (dbSet.includes(aiSet) || aiSet.includes(dbSet)) score += W.SET_NAME_FUZZY;
  }

  if (card.attacks?.length && d.attacks?.length) {
    const aiAttacks = card.attacks.map(a => (typeof a === 'string' ? a : a.name || '').toLowerCase());
    const dbAttacks = d.attacks.map(a => (a.name || '').toLowerCase());
    const matches = aiAttacks.filter(a => dbAttacks.some(da => da.includes(a) || a.includes(da)));
    score += matches.length * W.ATTACK_NAME_PER_MATCH;
  }

  const aiSuffix = extractPokemonSuffix(card.name);
  const dbSuffix = extractPokemonSuffix(d.name);
  if (aiSuffix && dbSuffix && aiSuffix === dbSuffix) score += W.SUFFIX_MATCH;
  else if (aiSuffix && dbSuffix && aiSuffix !== dbSuffix) score += W.SUFFIX_MISMATCH;

  if (card.regulation_mark && !regMarkMatchesEra(card.regulation_mark, d)) {
    score += W.REG_MARK_ERA_FAIL;
  }

  return score;
}

// =============================================================================
// verifyPokemon (V1 server.js:3537)
// =============================================================================

/**
 * Pokemon verify — local-DB short-circuit first, then race-and-score against
 * pokemontcg.io with alt-suffix and base-name+HP retries on miss. Returns a
 * verify-shape object or null.
 *
 * Race semantics: spawn N parallel /v2/cards queries. As each query resolves
 * we score every result and update globalBest. The first query whose best
 * score crosses RACE_THRESHOLD triggers a RACE_GRACE_MS grace timeout, then
 * the outer await resolves. After resolution: if globalBest scored ≥
 * MIN_ACCEPT_SCORE, return it; otherwise try alt-suffix retry; otherwise
 * try base-name+HP retry; otherwise return null.
 */
export async function verifyPokemon(card) {
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
          const hpOk = !aiHp || !dbHp || Math.abs(aiHp - dbHp) <= HP_MISMATCH_TOLERANCE;
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
              _refImagePromise: prefetchRefImage(localRefUrl),
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

    const perQueryPromises = queries.map(q =>
      axios.get('https://api.pokemontcg.io/v2/cards', {
        params: { q, pageSize: 20 },
        timeout: 10000,
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
          console.log(`[VERIFY-PKM] race trigger: "${r.q}" → ${r.queryBestScore} >= ${RACE_THRESHOLD}, ${RACE_GRACE_MS}ms grace`);
          setTimeout(finish, RACE_GRACE_MS);
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
        score,
      }));

    if (globalBest && globalBestScore >= MIN_ACCEPT_SCORE) {
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
        _refImagePromise: globalBestScore < DOUBLE_CHECK_SCORE_GATE ? prefetchRefImage(refUrl) : null,
      }, card.card_number);
    } else if (globalBest) {
      console.log(`[VERIFY-PKM] Best match "${globalBest.name}" scored ${globalBestScore}, below threshold ${MIN_ACCEPT_SCORE} — rejecting.`);
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
            timeout: 10000,
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
              _refImagePromise: prefetchRefImage(altRefUrl),
            }, card.card_number);
          }
        } catch { /* try next suffix */ }
      }

      try {
        console.log(`[VERIFY-PKM] Last resort: searching base name "${baseName}" with HP ${card.hp}`);
        const hpQuery = card.hp ? ` hp:${card.hp}` : '';
        const resp = await axios.get('https://api.pokemontcg.io/v2/cards', {
          params: { q: `name:"${baseName}"${hpQuery}`, pageSize: 20 },
          timeout: 10000,
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
              _refImagePromise: prefetchRefImage(baseRefUrl),
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

// =============================================================================
// fetchPokemonImageByCdnLookup — image-only CDN fetch for the fallback cascade
// =============================================================================

/**
 * Lean image-only lookup against pokemontcg.io. Used by the server-side
 * image-fallback cascade in pricing/price.js when CARD_DB has no image.
 * Does NOT refactor pricePokemonCard — this is a separate, minimal helper.
 *
 * @param {string} setId      pokemontcg.io set ID (e.g. 'sv1')
 * @param {string} cardNumber card number string (e.g. '45' or '45/198')
 * @returns {Promise<string|null>}
 */
export async function fetchPokemonImageByCdnLookup(setId, cardNumber) {
  const num = String(cardNumber).replace(/\/.*/, '');
  const resp = await axios.get('https://api.pokemontcg.io/v2/cards', {
    params: { q: `number:${num} set.id:${setId}`, pageSize: 5 },
    timeout: 8000,
  });
  const cards = resp.data?.data;
  if (!cards?.length) return null;
  const exact = cards.find(c => c.number === num) || cards[0];
  return exact.images?.large || exact.images?.small || null;
}

// =============================================================================
// pricePokemonCard (V1 server.js:4842)
// =============================================================================

/**
 * Pokemon price — V1 server.js:pricePokemonCard. Returns the V1 shape used
 * by /api/price route (cardmarket_price / tcgplayer / pokemontcg metadata).
 * Reads embedded cardmarket.prices + tcgplayer.prices off the same response.
 */
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
      timeout: 10000,
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
            url: d.tcgplayer.url || null,
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
        rarity: d.rarity,
      };
    }
  } catch (err) {
    console.error('Pokemon TCG API error:', err.message);
  }

  return prices;
}

/**
 * Default-export adapter. Confidence 0.70 (embedded daily snapshot — no
 * liquidity signal of its own; lose to TCGGO when both have data).
 *
 * Re-export cacheCardResult so the route handler can write back via the
 * pricing module rather than the transient _card-db-boot import path.
 */
export { cacheCardResult };

export default {
  name: NAME,
  supports: {
    games: ['pokemon'],
    needs: ['name'],
  },
  isAvailable() {
    return true; // free + unauthenticated; key only boosts rate limits
  },
  async verify(card /*, ctx */) {
    const v = await verifyPokemon(card);
    if (!v) return null;
    return {
      name: v.name,
      set_name: v.set_name,
      set_code: v.set_code,
      card_number: v.card_number,
      rarity: v.rarity ?? null,
      hp: v.hp ?? null,
      image: v.image || null,
      cardmarket_url: v.cardmarket_url || null,
      tcgplayer_url: v.tcgplayer_url || null,
      source: v.source,
      confidence_score: v.confidence_score,
      candidates: v.candidates,
      _additionals: v._additionals,
      _refImagePromise: v._refImagePromise || null,
    };
  },
  async price(card /*, ctx */) {
    const raw = await pricePokemonCard(card);
    if (!raw?.cardmarket_price) return null;
    return {
      source: NAME,
      market_value_eur: raw.cardmarket_price,
      raw_currency: 'EUR',
      raw_value: raw.cardmarket_price,
      confidence: 0.70,
      fetched_at: new Date().toISOString(),
      trend: raw.cardmarket_trend ?? null,
    };
  },
};
