// pricing/verify.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - pricing/adapter.interface.md (PricingAdapter contract)
//   - pricing/confidence.js (HP_MISMATCH_TOLERANCE)
//   - V1 server.js:verifyCard (3122-3294) — per-game dispatch + HP guard
//
// Per-game verify dispatcher. Reads card.game and routes to the appropriate
// adapter; runs the HP-mismatch re-search guard (Pokemon only) before
// trusting the verified result.
//
// HP-mismatch behaviour: if AI HP and DB HP disagree by more than
// HP_MISMATCH_TOLERANCE, we re-query pokemontcg.io with the AI's reported
// HP. If a higher-scoring candidate matches, we replace the verify result.
// If not, we set verify_rejected:'hp_mismatch' (the route handler skips
// identCache for cards with this flag — V2_AUDIT §5 invariant).

import { axios } from '../apps/server/_clients.js';
import { HP_MISMATCH_TOLERANCE } from './confidence.js';
import { resolveIdentity } from './set-resolve.js';
import { CARD_DB } from '../apps/server/_card-db-boot.js';
import { verifyPokemon, prefetchRefImage } from './adapters/pokemontcg.js';
import { verifyMagic } from './adapters/scryfall.js';
import { verifySWU } from './adapters/swu-db.js';
import { verifyYuGiOh } from './adapters/ygoprodeck.js';
import { verifyLorcana } from './adapters/lorcana.js';

/**
 * Generic-game verify branch. V1 server.js:3393-3411 — onepiece /
 * fleshandblood / dragonball / digimon return null in V1; only lorcana has
 * a real adapter call. Mirrors that here so the dispatcher contract stays
 * verbatim.
 */
async function verifyGeneric(card) {
  if (card.game === 'lorcana') return verifyLorcana(card);
  return null;
}

/**
 * Per-game verify dispatcher. Returns a card-shape with `.verified=true` on
 * success, `.verified=false` on miss / hp_mismatch reject. Mutates the
 * input via spread (does NOT mutate in place). Throws are caught and turned
 * into `.verified=false`.
 *
 * @param {object} card  PartialCard (AI-identified) — at minimum .game and
 *                       .name. Pokemon cards should also include .hp,
 *                       .set_code, .card_number for best results.
 */
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
      // HP-mismatch guard — Pokemon only, both sides must have HP.
      if (card.game === 'pokemon' && card.hp && verified.hp) {
        const aiHp = parseInt(card.hp);
        const dbHp = parseInt(verified.hp);
        if (aiHp && dbHp && Math.abs(aiHp - dbHp) > HP_MISMATCH_TOLERANCE) {
          console.log(`[VERIFY] HP MISMATCH! AI says HP ${aiHp}, DB card "${verified.name}" has HP ${dbHp}. Re-searching...`);
          const baseName = (card.name || '').replace(/\s*(ex|GX|EX|V|VMAX|VSTAR|LV\.X|-GX|-EX)\s*$/, '').replace(/-$/, '').trim();
          let hpMismatchResolved = false;
          try {
            const hpSearch = await axios.get('https://api.pokemontcg.io/v2/cards', {
              params: { q: `name:"${baseName}" hp:${card.hp}`, pageSize: 15 },
              timeout: 10000,
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
                  _refImagePromise: prefetchRefImage(hpRefUrl),
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

      // Resolve the set from (name, collector number, printed total) rather
      // than from the model's set-code guess. MEASURED: this lifted identity
      // accuracy from 49.0% to 68.6% and precision from 61% to 97.2% across
      // 51 photographs (docs/V3_BENCHMARK.md §18), and it fixes BOTH readers —
      // Gemini 3 Flash gained the same way, so it is not a model-specific
      // patch. See pricing/set-resolve.js for why a correction table does not
      // work here.
      // HINT ONLY. Named separately so it can never be mistaken for the
      // answer — the regression guard in tests/regression/set-resolve.spec.js
      // fails if the model's set code is ever returned as `set_code` again.
      const setCodeHint = verified.set_code || card.set_code;
      const resolved = resolveIdentity(
        { name: verified.name || card.name,
          card_number: verified.card_number || card.card_number,
          set_code: setCodeHint },
        CARD_DB,
      );

      return {
        ...card,
        name: verified.name || card.name,
        set_name: verified.set_name || card.set_name,
        // NEVER fall back to the model's set_code. It was `verified.set_code ||
        // card.set_code`, so a card the verifier had matched CORRECTLY could be
        // returned — and displayed — carrying the model's wrong set. That is
        // how a right answer came back labelled with the wrong set for weeks.
        set_code: verified.set_code || resolved.set_code || null,
        resolved_id: resolved.id,
        resolve_confidence: resolved.confidence,
        resolve_reason: resolved.reason,
        // True when the read refuted itself — e.g. "TWM 073/084" when
        // Twilight Masquerade has printedTotal 167. Carried 69% of the
        // observed set-attribution failures.
        read_contradicts_itself: resolved.contradiction,
        card_number: verified.card_number || card.card_number,
        rarity: verified.rarity || card.rarity,
        reference_image: verified.image || null,
        cardmarket_url: verified.cardmarket_url || null,
        tcgplayer_url: verified.tcgplayer_url || null,
        verified: true,
        db_source: verified.source,
        confidence_score: verified.confidence_score || null,
        candidates: verified.candidates || null,
        _refImagePromise: verified._refImagePromise || null,
      };
    } else {
      console.log(`[VERIFY] Could not verify — using AI identification as-is`);
    }
  } catch (err) {
    console.error(`[VERIFY] Error: ${err.message}`);
  }

  return { ...card, verified: false };
}

/**
 * Verify a batch of identified cards in parallel. Mirrors V1
 * server.js:verifyIdentified.
 */
export async function verifyIdentified(cards) {
  if (!cards?.length) return cards || [];
  return Promise.all(cards.map(card => verifyCard(card)));
}
