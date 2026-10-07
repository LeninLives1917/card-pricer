// apps/server/routes/quote-batch.js
//
// POST /api/v2/quote/batch — quote a whole list of cards in ONE request.
//
// Every line is matched LOCALLY by the typed resolver (pricing/text-entry) and
// priced from the hub's daily Cardmarket price guide (pricing/quote-prices).
// No outside call is made per card, so the limit is per quote, not per card,
// and a collection of hundreds of lines is a couple of seconds of CPU.
//
// WHAT A LINE CAN COME BACK AS
//
//   priced         one card, with today's Cardmarket number
//   unpriced       one card, but no number we will stand behind: not in the
//                  price guide, a 1st Edition / Shadowless print (not split out
//                  in the guide), or the snapshot is too old / never loaded.
//                  The customer sees "we'll price this one by hand".
//   ask            more than one real card fits the line, OR the card has a
//                  Classic Collection reprint printed with the very same name
//                  and number. Candidates come back WITH prices so the page
//                  can resolve the pick without another request.
//   not_found      nothing fits; the message says what to add.
//   not_supported  a language the English catalogue cannot answer for.
//
// What this route deliberately does NOT do: fall through to the remote lookup
// ladder. That ladder takes search hit #1 when nothing confirms it, and a
// public quote is the worst place to ship an unconfirmed identity.
//
// CUSTOMERS DO NOT TYPE LIKE THE SHOP. "rev Gengar 94/162", "2 x Charizard
// 4/102", "Charizard Base Set 4/102" and "Charizard 4/102 PSA 9" all failed or
// mispriced on the first build. pricing/text-entry/customer-line.js reads the
// quantity, language and grading marks, and offers rewrites that are tried
// ONLY after the line as typed has failed. Every rewrite that answers a line
// is marked on the row (`rescue`) and counted in /api/health -> quote_batch.

import express from 'express';
import { quoteBatchLimiter } from '../middleware/rate-limit.js';
import { CARD_DB } from '../_card-db-boot.js';
import { resolveTypedLine, buildNameNumberIndex } from '../../../pricing/text-entry/resolve-line.js';
import { buildNameIndex } from '../../../pricing/name-index.js';
import { loadSets } from '../../../pricing/set-resolve.js';
import { CONDITION_MULTIPLIERS } from '../../../pricing/conditions.js';
import { isUnsupportedLang } from '../../../pricing/languages.js';
import {
  getQuotePriceIndex, snapshotAgeDays, PRICE_STALE_DAYS,
} from '../../../pricing/quote-prices/hub-feed.js';
import {
  marketPriceOf, priceRowFor, reprintsFor, COL,
} from '../../../pricing/quote-prices/feed-index.js';
import {
  cleanCustomerLine, moveQualifiers, contextVariants, contextAgrees, gradeAndFinishOutsideName,
  stripSetName, buildSetNameTokens, setEvidence,
} from '../../../pricing/text-entry/customer-line.js';
import {
  countQuote, countRejectedTooMany, countRewriteBudgetExhausted,
} from '../../../infra/observability/quote-batch-counters.js';

const router = express.Router();

/** A whole collection, but bounded: ~2-3 s of resolver time at 1,000 lines. */
export const MAX_BATCH_LINES = 1000;
const MAX_LINE_CHARS = 200;
const MAX_CANDIDATES = 8;
const MAX_QTY = 99;

/** Sets whose cards ARE reprints; never ask the reprint question about them. */
const REPRINT_SETS = new Set(['cel25c', 'me55c']);

/** Split a pasted blob or an array into the lines worth resolving. */
export function linesOf(body) {
  const raw = Array.isArray(body?.lines)
    ? body.lines.map((l) => String(l ?? ''))
    : String(body?.text ?? '').split('\n');
  return raw
    .map((l) => l.trim().slice(0, MAX_LINE_CHARS))
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));
}

// ── Catalogue for quoting: CARD_DB plus any hub sets it does not have yet ──
let _deps = null;
function quoteDeps(cardDb, index) {
  if (_deps && _deps.base === cardDb && _deps.baseSize === cardDb.size && _deps.index === index) {
    return _deps.value;
  }
  let db = cardDb;
  if (index?.augment?.size) {
    db = new Map(cardDb);
    for (const [k, v] of index.augment) if (!db.has(k)) db.set(k, v);
  }
  const names = [];
  for (const v of db.values()) if (v?.name) names.push(v.name);
  const value = { cardDb: db, nameIndex: buildNameIndex(names), nameNumberIndex: buildNameNumberIndex(db) };
  _deps = { base: cardDb, baseSize: cardDb.size, index, value };
  return value;
}

let _setsById = null;
function setOf(setId) {
  if (!_setsById) _setsById = new Map(loadSets().map((s) => [s.id, s]));
  return _setsById.get(setId) ?? null;
}

function cardOf(id, db) {
  const v = db.get(id) || {};
  const dash = id.lastIndexOf('-');
  const setId = id.slice(0, dash);
  const ref = setOf(setId);
  return {
    id,
    set_id: setId,
    name: v.name ?? null,
    set_name: v.setName ?? ref?.name ?? null,
    set_code: ref?.ptcgoCode ?? v.setCode ?? null,
    card_number: id.slice(dash + 1),
    printed_total: ref?.printedTotal ?? null,
    ...(v.augmented ? { augmented: true } : {}),
  };
}

const NOT_FOUND_MESSAGES = {
  no_card_number: 'Add the number from the bottom of the card, e.g. Charizard 4/102.',
  no_name_and_number_alone_is_not_enough: 'A number on its own fits lots of cards. Add the name, e.g. Charizard 4/102.',
  name_prefix_too_short: 'Type a little more of the name, e.g. cha 4/102.',
  name_not_in_catalogue: "We couldn't find that name. Check the spelling, or type the first few letters and the number, e.g. cha 4/102.",
  name_known_but_not_at_that_number: "That name and number don't match a card we know. Check the number, including the part after the slash.",
  no_prefix_match_at_that_number: "That name and number don't match a card we know. Check the number, including the part after the slash.",
  printed_total_excludes_all: "That number doesn't match the set size printed on the card. Check the part after the slash.",
  unique_name_number_total_mismatch: "That number doesn't match the set size printed on the card. Check the part after the slash.",
  set_code_contradicts_printed_total: 'That set code and set size disagree. Try the card name and number instead.',
  set_code_and_number_not_in_catalogue: "We don't recognise that set code and number. Try the card name and number instead.",
  no_interpretation: "We couldn't read this line. Try the card name and the number from the bottom, e.g. Charizard 4/102.",
};
const DEFAULT_NOT_FOUND = "We couldn't match this line. Try the card name and the number from the bottom, e.g. Charizard 4/102.";

/** What the line itself says about a reprint, if anything. */
function reprintHint(line) {
  if (/\b30th\b/i.test(line)) return 'me55c';
  if (/celebration|classic|25th|\bcel\b/i.test(line)) return 'cel25c';
  return null;
}

/**
 * Extra resolver calls one request may spend on REWRITES of failed lines
 * (moved qualifiers, dropped set words). A line that fails every rewrite
 * costs up to 13 resolves, so a 1,000-line paste of junk would be ~13x the
 * normal work; past this budget a line is answered as typed, and the
 * exhaustion is counted.
 */
export const REWRITE_BUDGET = 4000;

function spend(ctx) {
  if (!ctx.rewrites) return true;
  if (ctx.rewrites.used >= ctx.rewrites.max) {
    if (!ctx.rewrites.exhausted) { ctx.rewrites.exhausted = true; countRewriteBudgetExhausted(); }
    return false;
  }
  ctx.rewrites.used += 1;
  return true;
}

const placed = (r) => r?.status === 'resolved' || r?.status === 'multi';

/**
 * An ambiguity the typed denominator already rules out: "Deoxys Lombre
 * 33/107" offers Deoxys cards numbered 33 from sets of other sizes, because
 * the resolver lists name-and-number candidates when the total excludes them
 * all. A question built from that is a question about the wrong cards, so
 * the rewrites get a turn before it is asked.
 */
function weakAmbiguity(r, ctx) {
  const total = Number(r.interpretation?.total);
  if (r.status !== 'ambiguous' || !total) return false;
  return !(r.candidates || []).some((c) => Number(cardOf(c.id, ctx.deps.cardDb).printed_total) === total);
}

/**
 * Resolve a customer's line: AS TYPED FIRST, then the rewrites from
 * pricing/text-entry/customer-line.js, each tried only when everything before
 * it failed. A line the resolver already answers is answered exactly as it
 * was, which is what keeps "Light Dragonite 14/105" a Light Dragonite.
 *
 * @returns {{r: object, readAs: string|null, how: string|null, dropped: string[]|null}}
 */
function resolveCustomer(text, ctx, opts) {
  const r0 = ctx.resolve(text, ctx.deps, opts);
  const asTyped = { r: r0, readAs: null, how: null, dropped: null };
  if (placed(r0) || (r0.status === 'ambiguous' && !weakAmbiguity(r0, ctx))) return asTyped;

  // Questions, best first: a real one a rewrite found, then one the typed
  // total rules out (as typed, or from a rewrite). Either beats a "not found"
  // that blames the name: "rev Gengar 94/162" has a fine name and a wrong
  // total, and the customer can still pick their Gengar.
  let strong = null;
  let weak = r0.status === 'ambiguous' ? asTyped : null;
  const attempt = (lineText, how, dropped, noSplit) => {
    if (!spend(ctx)) return null;
    const r = ctx.resolve(lineText, ctx.deps, noSplit ? { ...opts, noSplit: true } : opts);
    const out = { r, readAs: lineText, how, dropped };
    if (r.status === 'resolved') return out;
    if (r.status === 'ambiguous' && dropped?.length) {
      // The words that were dropped may be the very set name that settles it:
      // "Water Energy Gym Heroes 132/132" fits Gym Heroes and Gym Challenge
      // by number, and only one of them is called Gym Heroes.
      const total = Number(r.interpretation?.total);
      const named = (r.candidates || []).filter((c) => {
        const card = cardOf(c.id, ctx.deps.cardDb);
        return (!total || Number(card.printed_total) === total) && setEvidence(dropped, card);
      });
      if (named.length === 1) {
        return { ...out, r: { ...r, status: 'resolved', card_id: named[0].id, candidates: named, reason: 'set_named_on_line' } };
      }
    }
    if (r.status === 'ambiguous') {
      if (!weakAmbiguity(r, ctx)) strong = strong ?? out;
      else weak = weak ?? out;
    }
    return null;
  };

  // 1. Qualifiers in front of the name: "rev Gengar 94/162", "4/102 Charizard".
  const moved = moveQualifiers(text);
  for (const m of moved) {
    const hit = attempt(m, 'qualifiers_moved', null, false);
    if (hit) return hit;
  }

  // 2. A set name in the way: "Charizard Base Set 4/102" (on the line as
  // typed and as rewritten: "Light Piloswine Neo Destiny 26/105" must keep its
  // Light). Then, failing that, any words around the name, longest kept span
  // first. The caller checks the dropped words against the card it gets.
  const basis = moved[0] ?? text;
  const tokens = setNameTokens(ctx);
  const tries = [...new Set([text, basis])].flatMap((t) => stripSetName(t, tokens));
  for (const v of [...tries, ...contextVariants(basis)]) {
    const hit = attempt(v.text, 'context_dropped', v.dropped, true);
    if (hit) return hit;
    if (ctx.rewrites?.exhausted) break;
  }
  return strong ?? weak ?? asTyped;
}

/** Set names for stripSetName, from the catalogue being quoted against. */
function setNameTokens(ctx) {
  if (ctx.deps._setNameTokens) return ctx.deps._setNameTokens;
  const names = new Set(loadSets().map((s) => s.name));
  for (const v of ctx.deps.cardDb.values()) if (v?.setName) names.add(v.setName);
  ctx.deps._setNameTokens = buildSetNameTokens(names);
  return ctx.deps._setNameTokens;
}

/**
 * Quote one line. Pure apart from the injected resolver and index.
 * @returns {object[]} usually one row; a line holding two cards returns two.
 */
export function quoteLine(line, ctx, opts = {}) {
  const cleaned = cleanCustomerLine(line);
  const text = cleaned.text || String(line ?? '').trim();

  if (isUnsupportedLang(cleaned.lang)) {
    return [notSupportedRow({ line, qty: cleaned.qty ?? 1, condition: 'NM', condition_multiplier: 1, finish: null }, cleaned.lang)];
  }

  const { r, readAs, how, dropped } = resolveCustomer(text, ctx, opts);
  const interp = r.interpretation || null;
  const found = r.status === 'resolved' && r.card_id ? cardOf(r.card_id, ctx.deps.cardDb) : null;
  const qty = Math.min(MAX_QTY, Math.max(1, Number(cleaned.qty ?? interp?.qty) || 1));
  const condition = CONDITION_MULTIPLIERS[interp?.condition] != null ? interp.condition : 'NM';
  const typed = {
    line,
    qty,
    condition,
    condition_multiplier: CONDITION_MULTIPLIERS[condition] ?? 1,
    finish: interp?.finish ?? null,
    // How the line was read when it was NOT read as typed. Counted, and shown
    // to nobody: it is for the shop's logs and /api/health.
    ...(how ? { read_as: readAs, rescue: how } : {}),
  };
  // "Light Dragonite" is not a lightly played Dragonite, and "Good Rod" is
  // not in Good condition. The card's own name once it is known; until then
  // the name as the resolver read it. Not both: "rev Revive 85/108" reads its
  // name as "rev Revive", and that "rev" is the customer's reverse holo.
  const own = gradeAndFinishOutsideName(readAs ?? text, found ? found.name : interp?.name);
  const base = own ? withGrade(typed, own) : typed;

  if (isUnsupportedLang(interp?.lang)) return [notSupportedRow(base, interp.lang)];

  if (r.status === 'multi' && Array.isArray(r.pieces) && !opts.noSplit) {
    return r.pieces.flatMap((p) => quoteLine(p.text, ctx, { noSplit: true }));
  }

  // A graded slab is worth a multiple of the raw card, and the guide prices
  // raw cards. Never quote one as a raw NM copy.
  if (cleaned.graded) {
    return [{ ...base, status: 'unpriced', unpriced_reason: 'graded', card: found }];
  }

  if (found) {
    const row = rowForCard(r.card_id, base, ctx);
    if (how === 'context_dropped' && row.status !== 'ask') {
      // The name and number found a card once words were dropped. Trust it
      // only when the dropped words say nothing against it ("Base Set" next
      // to a Base card) and the name matched as typed, not by typo repair.
      const sure = (r.name_match === 'exact' || r.name_match === 'prefix')
        && contextAgrees(dropped, found);
      if (!sure) {
        return [{
          ...base,
          status: 'ask',
          rescue: 'context_unconfirmed',
          question: 'Is this your card?',
          candidates: [candidateOf(r.card_id, base.finish, ctx)],
        }];
      }
    }
    return [row];
  }

  if (r.status === 'ambiguous' && r.candidates?.length) {
    return [{
      ...base,
      status: 'ask',
      question: 'This could be more than one card. Which one is it?',
      candidates: withReprints(r.candidates.map((c) => c.id), base.finish, ctx),
    }];
  }

  return [{
    ...base,
    status: 'not_found',
    reason: r.reason ?? null,
    message: NOT_FOUND_MESSAGES[r.reason] ?? DEFAULT_NOT_FOUND,
  }];
}

const LANG_NAMES = { ja: 'Japanese', jp: 'Japanese', ko: 'Korean', zh: 'Chinese' };

function notSupportedRow(base, lang) {
  const name = LANG_NAMES[String(lang).toLowerCase()] ?? String(lang).toUpperCase();
  return {
    ...base, status: 'not_supported',
    message: `We can only quote English cards online for now. Bring ${name} cards into the shop and we'll price them there.`,
  };
}

function priceFor(cardId, finish, ctx) {
  if (!ctx.usable) return { price: null, reason: ctx.unusableReason };
  const row = priceRowFor(ctx.index, cardId);
  const p = marketPriceOf(row, { finish });
  if (p.value == null) return { price: null, reason: p.reason };
  return {
    price: {
      market: p.value,
      field: p.field,
      capped: p.capped,
      dip: !!p.dip,
      finish_fallback: p.finish_fallback,
      as_of: ctx.index.snapshotDate,
      source: 'cardmarket_price_guide',
      id_product: row?.[COL.idProduct] ?? null,
    },
  };
}

function candidateOf(cardId, finish, ctx) {
  const pr = priceFor(cardId, finish, ctx);
  return { card: cardOf(cardId, ctx.deps.cardDb), price: pr.price, unpriced_reason: pr.price ? null : pr.reason };
}

/** base with the grade and finish replaced (see gradeAndFinishOutsideName). */
function withGrade(base, { condition, finish }) {
  const c = condition && CONDITION_MULTIPLIERS[condition] != null ? condition : 'NM';
  return { ...base, condition: c, condition_multiplier: CONDITION_MULTIPLIERS[c] ?? 1, finish: finish ?? null };
}

/**
 * The candidates for a question, each followed by its anniversary reprints.
 * A reprint carries the original's name and number, so a question listing the
 * original without it invites the dearer pick for a card that is the reprint.
 */
function withReprints(ids, finish, ctx) {
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    if (out.length >= MAX_CANDIDATES) break;
    if (seen.has(id)) continue;
    seen.add(id);
    const c = candidateOf(id, finish, ctx);
    out.push(c);
    if (REPRINT_SETS.has(c.card.set_id) || finish === 'first_edition' || finish === 'shadowless') continue;
    for (const e of reprintsFor(ctx.index, c.card.name, c.card.card_number)) {
      if (seen.has(e.key) || out.length >= MAX_CANDIDATES) continue;
      seen.add(e.key);
      out.push(reprintCandidate(e, ctx));
    }
  }
  return out;
}

function rowForCard(cardId, base, ctx) {
  const card = cardOf(cardId, ctx.deps.cardDb);

  // THE CLASSIC COLLECTION QUESTION. Reprints carry the original's name and
  // number, so "Charizard 4/102" describes a Base Set Charizard and both
  // anniversary reprints equally well, and the prices are an order of magnitude
  // apart. Measured: 18 of the 18 wrong answers in a whole-catalogue sweep of
  // "name number/total" were Celebrations reprints resolved to the original.
  // A 1st Edition or Shadowless print is the original by definition: the
  // anniversary reprints carry neither mark, so there is nothing to ask.
  const originalOnly = base.finish === 'first_edition' || base.finish === 'shadowless';
  if (!REPRINT_SETS.has(card.set_id) && !originalOnly) {
    const reprints = reprintsFor(ctx.index, card.name, card.card_number);
    if (reprints.length) {
      const hint = reprintHint(base.line);
      const chosen = hint ? reprints.find((e) => e.reprint_set === hint) : null;
      if (chosen) return reprintRow(chosen, base, ctx);
      const original = candidateOf(cardId, base.finish, ctx);
      return {
        ...base,
        status: 'ask',
        reprint_question: true,
        question: 'Is there a 25th or 30th anniversary stamp on the card? Reprints of this card exist and are worth much less than the original.',
        candidates: [
          { ...original, label: `Original (${card.set_name ?? card.set_id})` },
          ...reprints.map((e) => reprintCandidate(e, ctx)),
        ],
      };
    }
  }

  const pr = priceFor(cardId, base.finish, ctx);
  if (!pr.price) return { ...base, status: 'unpriced', unpriced_reason: pr.reason, card };
  return { ...base, status: 'priced', card, price: pr.price };
}

function reprintCard(e) {
  return {
    id: e.key,
    set_id: e.reprint_set,
    name: e.name,
    set_name: e.set_name,
    set_code: setOf(e.reprint_set)?.ptcgoCode ?? null,
    card_number: e.card_number,
    printed_total: null,
  };
}

function reprintCandidate(e, ctx) {
  const p = ctx.usable ? marketPriceOf(e.row) : { value: null, reason: ctx.unusableReason };
  const price = p.value == null ? null : {
    market: p.value, field: p.field, capped: p.capped, dip: !!p.dip, finish_fallback: false,
    as_of: ctx.index.snapshotDate, source: 'cardmarket_price_guide',
    id_product: e.row?.[COL.idProduct] ?? null,
  };
  return { card: reprintCard(e), price, unpriced_reason: price ? null : (p.reason ?? 'no_cardmarket_product'), label: e.label };
}

function reprintRow(e, base, ctx) {
  const c = reprintCandidate(e, ctx);
  if (!c.price) return { ...base, status: 'unpriced', unpriced_reason: c.unpriced_reason, card: c.card };
  return { ...base, status: 'priced', card: c.card, price: c.price };
}

/**
 * Core, dependency-injected (same convention as handleQuoteLead).
 *
 * @param {object} body  { lines: string[] } or { text: string }, game
 * @param {object} [deps]
 */
export async function handleQuoteBatch(body, deps = {}) {
  const cardDb = deps.cardDb ?? CARD_DB;
  const index = deps.priceIndex !== undefined ? deps.priceIndex : getQuotePriceIndex();
  const now = deps.now ?? Date.now();
  const resolve = deps.resolve ?? resolveTypedLine;

  const game = String(body?.game ?? 'pokemon').toLowerCase();
  if (game !== 'pokemon') {
    return { status: 400, body: { error: 'Whole-list quotes are Pokémon only for now.' } };
  }
  const lines = linesOf(body);
  if (!lines.length) {
    return { status: 400, body: { error: 'Enter at least one card, e.g. Charizard 4/102.' } };
  }
  if (lines.length > MAX_BATCH_LINES) {
    countRejectedTooMany();
    return {
      status: 413,
      body: { error: `Up to ${MAX_BATCH_LINES} cards per quote. Split the list and send the rest separately.`, max_lines: MAX_BATCH_LINES },
    };
  }
  if (!cardDb || cardDb.size === 0) {
    return { status: 503, body: { error: 'The card catalogue is still loading. Please try again in a minute.' } };
  }

  const age = index ? snapshotAgeDays(index.snapshotDate, now) : null;
  const usable = !!index && age !== null && age <= PRICE_STALE_DAYS;
  const ctx = {
    deps: quoteDeps(cardDb, index),
    index,
    usable,
    unusableReason: !index ? 'prices_unavailable' : 'prices_stale',
    resolve,
    rewrites: { used: 0, max: deps.rewriteBudget ?? REWRITE_BUDGET, exhausted: false },
  };

  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    rows.push(...quoteLine(lines[i], ctx));
    // Give the event loop a turn so a long list does not stall other requests.
    if (i % 25 === 24) await new Promise((r) => setImmediate(r));
  }

  const summary = { lines: lines.length, rows: rows.length, priced: 0, unpriced: 0, ask: 0, not_found: 0, not_supported: 0, cards_priced: 0 };
  for (const r of rows) {
    summary[r.status] = (summary[r.status] || 0) + 1;
    if (r.status === 'priced') summary.cards_priced += r.qty;
  }

  countQuote(rows);
  const rescued = rows.filter((r) => r.rescue).length;
  console.log(`[QUOTE-BATCH] ${lines.length} line(s): ${summary.priced} priced, ${summary.ask} asked, `
    + `${summary.unpriced} by hand, ${summary.not_found} not found, ${rescued} read by rewrite `
    + `(${ctx.rewrites.used} rewrite resolve(s)${ctx.rewrites.exhausted ? ', BUDGET EXHAUSTED' : ''}; `
    + `prices ${index?.snapshotDate ?? 'unavailable'}${usable ? '' : ', NOT USED'})`);

  return {
    status: 200,
    body: {
      ok: true,
      currency: 'EUR',
      prices_as_of: index?.snapshotDate ?? null,
      prices_age_days: age === null ? null : Number(age.toFixed(1)),
      prices_usable: usable,
      price_source: 'Cardmarket price guide (trend)',
      summary,
      rows,
    },
  };
}

router.post('/api/v2/quote/batch', quoteBatchLimiter, async (req, res) => {
  try {
    const result = await handleQuoteBatch(req.body || {});
    res.status(result.status).json(result.body);
  } catch (e) {
    console.error('[QUOTE-BATCH] failed:', e);
    res.status(500).json({ error: 'Quote failed — please try again.' });
  }
});

export default router;
