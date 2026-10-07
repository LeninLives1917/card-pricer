// pricing/quote-prices/feed-index.js
//
// Price the customer quote from the hub's daily Cardmarket price guide instead
// of a live call per card.
//
// WHY
//
// The quote page used to make two live requests per card (identify, then a
// price ladder that fans out to Cardmarket, pokemontcg.io, JustTCG, TCGGO and
// eBay), all behind one 10-per-hour limiter shared with the email step. A
// customer could quote 4 cards. Identity is already local (pricing/text-entry);
// this module makes the PRICE local too, so a whole collection is one request.
//
// THE DATA (boardbrewed-hub Supabase, rpc quote_price_feed, rebuilt hourly)
//
//   cm_tcggo_daily      TCGGO's daily pull: the cheapest Near Mint English
//                       copy per Cardmarket product, the number the shop
//                       scanner prices from. What the quote uses (marketPriceOf)
//   cm_price_snapshot   Cardmarket's own daily price guide: avg, low, trend,
//                       avg1/7/30, and the same with _holo (= reverse holo).
//                       The cross-check, and the fallback
//   cm_card_meta        the TCGdex card list, with Cardmarket's id_product
//   cm_sets             TCGdex sets, with the printed total
//
// The catalogue this app matches against is keyed by pokemontcg.io ids
// (`sv3pt5-4`); the hub is keyed by TCGdex ids (`sv03.5`, local id `004`). This
// module joins the two: set ids by a reviewed map, collector numbers by one
// normalisation applied to both sides, and NAMES AS A CHECK. A number that
// matches with a name that does not is refused, not trusted — that is how a
// mapped price lands on the wrong card without anyone noticing.
//
// Pure: no fs, no network. hub-feed.js owns fetching and refresh.

import { normName, editDistanceWithin } from '../name-index.js';

/**
 * Column layout of a feed card row (see quote_price_feed_build() in the hub).
 * 16-19 arrived with feed version 2 (7 Oct 2026): TCGGO's cheapest Near Mint
 * English copy for the Cardmarket product, and what TCGGO calls the product,
 * so the two can be checked against each other before the number is used.
 */
export const COL = Object.freeze({
  set: 0, local: 1, name: 2, idProduct: 3,
  trend: 4, avg7: 5, avg30: 6, avg: 7, low: 8,
  trendHolo: 9, avg7Holo: 10, avg30Holo: 11, avgHolo: 12, lowHolo: 13,
  firstEd: 14, hasReverse: 15,
  nmEn: 16, tcggoRows: 17, tcggoName: 18, tcggoNumber: 19,
});

/** Column layout of a feed set row. */
export const SET_COL = Object.freeze({ id: 0, name: 1, abbr: 2, official: 3, total: 4, released: 5 });

/**
 * One collector number, normalised the same way on both sides: upper-case,
 * leading zeros stripped from the digit run. TCGdex pads ("004", "SV001",
 * "TG01"), pokemontcg.io mostly does not ("4", "SV1"... and sometimes does).
 *
 *   "004" -> "4"   "SV001" -> "SV1"   "TG01" -> "TG1"   "189a" -> "189A"
 */
export function normCardNumber(n) {
  const s = String(n ?? '').trim().toUpperCase();
  const m = s.match(/^([A-Z]*)0*(\d+)([A-Z]*)$/);
  return m ? m[1] + m[2] + m[3] : s;
}

/**
 * pokemontcg.io set id -> TCGdex set id, where they differ. Reviewed by hand
 * against both set lists on 7 Oct 2026; 126 of the 174 reference sets share an
 * id and need no entry. Anything not resolved here or by the shape rules below
 * is reported as unmapped in /api/health rather than guessed.
 */
export const SET_MAP = Object.freeze({
  base6: 'lc',
  hsp: 'hgssp',
  bp: 'bog',
  fut20: 'fut2020',
  tk1a: 'tk-ex-latia', tk1b: 'tk-ex-latio', tk2a: 'tk-ex-p', tk2b: 'tk-ex-m',
  mcd11: '2011bw', mcd12: '2012bw', mcd14: '2014xy', mcd15: '2015xy',
  mcd16: '2016xy', mcd17: '2017sm', mcd18: '2018sm', mcd19: '2019sm',
  mcd21: '2021swsh', mcd22: '2022swsh',
  sm35: 'sm3.5', sm75: 'sm7.5',
  swsh35: 'swsh3.5', swsh45: 'swsh4.5', swsh45sv: 'swsh4.5sv',
  swsh12pt5: 'swsh12.5', swsh12pt5gg: 'swsh12.5gg',
  pgo: 'swsh10.5',
  cel25c: 'cel25cc',
  zsv10pt5: 'sv10.5b', rsv10pt5: 'sv10.5w',
  // Duplicate set ids the live catalogue picked up from fallback sources. Same
  // physical cards as the two above.
  bbt: 'sv10.5b', wht: 'sv10.5w',
});

/**
 * Subsets pokemontcg.io keeps inside a main set but TCGdex splits out. Tried
 * after the primary set, and only by collector number with the name check.
 */
export const SECONDARY_SETS = Object.freeze({
  bw11: ['rc'],   // Legendary Treasures Radiant Collection, RC1-RC25
  ex10: ['exu'],  // Unseen Forces Unown, A-Z ! ?
});

/**
 * Hub sets that the catalogue does not have yet, added for quoting under the
 * id pokemontcg.io uses upstream. When a crawl brings the set into the
 * catalogue the augmentation steps aside (the catalogue wins).
 *
 * Only the 30th Celebration main set. Its Classic Collection is handled as a
 * REPRINT question instead, because those cards carry their original numbers
 * and TCGdex numbers them 001-030.
 */
export const AUGMENT_SETS = Object.freeze({
  '30th': { id: 'me55', name: '30th Celebration', code: '30C' },
});

/** pokemontcg.io set id -> TCGdex set id, or null. */
export function tcgdexSetFor(pkmSetId, tcgdexSetIds) {
  const id = String(pkmSetId ?? '').toLowerCase();
  if (!id) return null;
  if (SET_MAP[id]) return tcgdexSetIds.has(SET_MAP[id]) ? SET_MAP[id] : null;
  if (tcgdexSetIds.has(id)) return id;
  // Shape rules: sv3 -> sv03, sv3pt5 -> sv03.5, me2pt5 -> me02.5, sv10 -> sv10.
  const m = id.match(/^(sv|me)(\d{1,2})(pt5)?$/);
  if (m) {
    const t = `${m[1]}${m[2].padStart(2, '0')}${m[3] ? '.5' : ''}`;
    if (tcgdexSetIds.has(t)) return t;
  }
  return null;
}

/**
 * Do two printings of a name refer to the same card? Exact after folding, or
 * one a clean extension of the other ("Umbreon" / "Umbreon Star"), or a small
 * spelling difference on a long name. Anything else is a different card.
 */
export function namesAgree(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  if (s.length >= 4 && l.startsWith(s) && l.length - s.length <= 6) return true;
  if (s.length >= 6) return editDistanceWithin(x, y, 2) <= 2;
  return false;
}

const pos = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const round2 = (n) => Math.round(n * 100) / 100;

/** A trend more than this multiple of the 30-day average is treated as a spike. */
export const SPIKE_RATIO = 3;

/**
 * THE OTHER DIRECTION: a trend that has collapsed under the recent averages.
 *
 * Measured on the 6 Oct 2026 guide: 203 priced cards had a trend under a third
 * of their 7- or 30-day average, 43 of them on cards averaging over EUR 5, and
 * some rows are plainly broken. Gengar (HS—Triumphant 94): trend 0.02, avg7
 * 269.56, avg30 908.54, cheapest listing 59.99. Ho-Oh-GX (Burning Shadows
 * 131): trend 0.02, avg30 24.78. Quoting the trend offers a customer two cent
 * for a card the shop could not buy for less than sixty euro.
 *
 * A dip uses the median of trend, avg7 and avg30 (with one average, the
 * average) and is flagged. When the three disagree by more than BROKEN_RATIO
 * on a card worth at least BROKEN_MIN_EUR, no number is quoted: the guide is
 * not telling us the price, so the shop prices it by hand.
 */
export const BROKEN_RATIO = 10;
export const BROKEN_MIN_EUR = 2;

/**
 * THE CHEAPEST NEAR MINT ENGLISH COPY (7 Oct 2026, Dave's call).
 *
 * The quote used to price from the guide's trend while the shop scanner
 * (pricing/price.js) prices from TCGGO's lowest_near_mint, the cheapest NM
 * English copy for sale, so online and at the counter started from different
 * numbers: Mew ex 152/128 trend 99.21 against 105, Charizard ex 125/197 3.51
 * against 2.50. The quote now uses the scanner's number, from the hub's daily
 * TCGGO pull, and keeps the guide as the cross-check and the fallback.
 *
 * Measured on 7 Oct: a clean NM English price for 18,231 of the 20,121 hub
 * cards with a trend. The guide's value (with the spike and dip handling
 * above) is used instead, and counted, when there is none. Two outcomes go to
 * the shop as by hand, because neither number can be trusted:
 *
 *   product_unconfirmed  TCGGO and TCGdex put a different card on the same
 *                        Cardmarket product: Snorlax swsh1-140 sits on the
 *                        product Cardmarket itself calls "Snorlax VMAX", and so
 *                        did its trend (69.66). Numbers are compared, except in
 *                        the Classic Collection sets, which TCGGO numbers the
 *                        way the card is printed (BS004 for 30th-c 001).
 *   prices_disagree      the NM English copy and the guide are NM_EN_RATIO
 *                        apart or more (Darkrai LV.X dp4-104: 750 against a
 *                        trend of 33.17). The scanner uses the same factor
 *                        between sources (detectPriceDivergence). Checked when
 *                        the dearer of the two is the copy and it is at least
 *                        NM_EN_OVER_MIN_EUR, or the guide and it is at least
 *                        NM_EN_UNDER_MIN_EUR: bulk lists at EUR 0.02 against
 *                        trends of 0.10, and that is the market, not a fault.
 */
export const NM_EN_RATIO = 5;
export const NM_EN_OVER_MIN_EUR = 0.5;
export const NM_EN_UNDER_MIN_EUR = 2;

/** TCGdex sets whose cards TCGGO numbers as printed (the original's number). */
export const NUMBERS_DIFFER_BY_DESIGN = new Set(['cel25cc', '30th-c']);

const lastDigits = (s) => {
  const m = String(s ?? '').match(/(\d+)\D*$/);
  return m ? Number(m[1]) : null;
};

/** true / false, or null when either side has no number to compare. */
export function numbersAgree(a, b) {
  const x = lastDigits(a);
  const y = lastDigits(b);
  return x == null || y == null ? null : x === y;
}

/**
 * Is TCGGO's record of this row's Cardmarket product the same card?
 * @returns {'ok'|'not_in_feed'|'not_in_tcggo'|'shared_product'|'name_differs'|'product_unconfirmed'}
 */
export function tcggoCheck(row) {
  if (!Array.isArray(row) || row.length <= COL.tcggoNumber) return 'not_in_feed';
  const n = row[COL.tcggoRows];
  if (n == null) return 'not_in_tcggo';
  if (n > 1) return 'shared_product';
  if (!NUMBERS_DIFFER_BY_DESIGN.has(row[COL.set])
    && numbersAgree(row[COL.tcggoNumber], row[COL.local]) === false) return 'product_unconfirmed';
  if (!namesAgree(row[COL.tcggoName], row[COL.name])) return 'name_differs';
  return 'ok';
}

function pricesDisagree(nm, guide) {
  if (nm >= NM_EN_RATIO * guide && nm >= NM_EN_OVER_MIN_EUR) return true;
  if (guide >= NM_EN_RATIO * nm && guide >= NM_EN_UNDER_MIN_EUR) return true;
  return false;
}

/**
 * The market value to quote from, and which field it came from.
 *
 * The cheapest NM English copy (`nm_en`, see above), checked against the
 * guide. The guide's value is Cardmarket TREND: the guide's own reference
 * price. Not `low` — that is the cheapest listing in ANY condition, measured
 * at 0.35-0.48 of an EX+ copy (pricing/conditions.js), so it would
 * systematically under-quote a Near Mint card.
 *
 * A trend more than SPIKE_RATIO x the 30-day average is capped to the average
 * and flagged. On a thin market one odd sale moves the trend; a quote that
 * promises that number to a stranger is the expensive mistake. A trend that
 * has collapsed under its averages is smoothed (`dip`) or, when the guide's
 * own numbers are an order of magnitude apart, not quoted at all
 * (`price_unstable`); see BROKEN_RATIO. A card the guide cannot price is not
 * priced from the NM English copy alone: there is nothing to check it against.
 *
 * Reverse holo uses the guide's _holo fields, and only on cards that have a
 * reverse printing: TCGGO's number is for the product, not the reverse. First
 * Edition and Shadowless are not separate in the price guide, so they are NOT
 * priced here: guessing the unlimited price for a 1st Edition card is wrong by
 * a multiple.
 *
 * @param {Array} row  a feed card row
 * @param {object} [opts]
 * @param {string|null} [opts.finish]
 * @param {string|null} [opts.nmEnOff]  why NM English cannot be used for any
 *   card right now ('nm_en_missing', 'nm_en_stale'), or null
 * @returns {{value:number, field:string, basis:'nm_en'|'trend', capped:boolean,
 *   finish_fallback:boolean, nm_en_fallback?:string}|{value:null, reason:string}}
 */
export function marketPriceOf(row, { finish = null, nmEnOff = null } = {}) {
  if (!row || row[COL.idProduct] == null) return { value: null, reason: 'no_cardmarket_product' };
  if (finish === 'first_edition' || finish === 'shadowless') {
    return { value: null, reason: finish };
  }
  const tc = tcggoCheck(row);
  if (tc === 'product_unconfirmed') return { value: null, reason: 'product_unconfirmed' };
  // Asked for a reverse holo of a card that has no reverse printing: price the
  // card that exists, and say the finish could not be applied.
  if (finish === 'reverse_holo' && row[COL.hasReverse] !== true) {
    const n = marketPriceOf(row, { nmEnOff });
    return n.value == null ? n : { ...n, finish_fallback: true };
  }
  const wantHolo = finish === 'reverse_holo';
  const pick = (holo) => {
    const t = pos(row[holo ? COL.trendHolo : COL.trend]);
    const a7 = pos(row[holo ? COL.avg7Holo : COL.avg7]);
    const a30 = pos(row[holo ? COL.avg30Holo : COL.avg30]);
    const avg = pos(row[holo ? COL.avgHolo : COL.avg]);
    const sfx = holo ? '_holo' : '';
    if (t != null) {
      if (a30 != null && t > SPIKE_RATIO * a30) return { value: round2(a30), field: 'avg30' + sfx, capped: true };
      const refs = [a7, a30].filter((v) => v != null);
      if (refs.length && t * SPIKE_RATIO < Math.max(...refs)) {
        const vals = [t, ...refs].sort((x, y) => x - y);
        const mid = vals.length === 3 ? vals[1] : vals[vals.length - 1];
        if (vals[vals.length - 1] > BROKEN_RATIO * vals[0] && mid >= BROKEN_MIN_EUR) return { unstable: true };
        return { value: round2(mid), field: (mid === a7 ? 'avg7' : 'avg30') + sfx, capped: false, dip: true };
      }
      return { value: round2(t), field: 'trend' + sfx, capped: false };
    }
    if (a7 != null) return { value: round2(a7), field: 'avg7' + sfx, capped: false };
    if (a30 != null) return { value: round2(a30), field: 'avg30' + sfx, capped: false };
    if (avg != null) return { value: round2(avg), field: 'avg' + sfx, capped: false };
    return null;
  };
  const UNSTABLE = { value: null, reason: 'price_unstable' };
  if (wantHolo) {
    const h = pick(true);
    if (h?.unstable) return UNSTABLE;
    if (h) return { ...h, basis: 'trend', nm_en_fallback: 'reverse_holo', finish_fallback: false };
    // No reverse prices in the guide: the standard card, by the usual rule.
    const n = marketPriceOf(row, { nmEnOff });
    return n.value == null ? n : { ...n, finish_fallback: true };
  }
  const g = pick(false);
  if (g?.unstable) return UNSTABLE;
  if (!g) return { value: null, reason: 'no_price_in_guide' };
  const onGuide = (why) => ({ ...g, basis: 'trend', nm_en_fallback: why, finish_fallback: false });
  if (nmEnOff) return onGuide(nmEnOff);
  if (tc !== 'ok') return onGuide(tc);
  const nm = pos(row[COL.nmEn]);
  if (nm == null) return onGuide('no_listing');
  if (pricesDisagree(nm, g.value)) return { value: null, reason: 'prices_disagree' };
  return { value: round2(nm), field: 'nm_en', basis: 'nm_en', capped: false, finish_fallback: false };
}

/**
 * Join the feed to the catalogue.
 *
 * @param {object} feed     the parsed quote_price_feed() document
 * @param {Map}    cardDb   catalogue: `${setId}-${number}` -> { name, setName, ... }
 * @param {Array}  pkmSets  pricing/reference/pokemon-sets.json
 * @param {Array}  [reprintList] pricing/reference/classic-collection-reprints.json
 */
export function buildPriceIndex(feed, cardDb, pkmSets = [], reprintList = []) {
  const sets = Array.isArray(feed?.sets) ? feed.sets : [];
  const cards = Array.isArray(feed?.cards) ? feed.cards : [];
  const tcgdexSetIds = new Set(sets.map((s) => s[SET_COL.id]));

  // TCGdex set -> number -> rows, and set -> folded name -> rows.
  const byNum = new Map();
  const byName = new Map();
  for (const row of cards) {
    const set = row[COL.set];
    if (!byNum.has(set)) { byNum.set(set, new Map()); byName.set(set, new Map()); }
    const nk = normCardNumber(row[COL.local]);
    const nm = normName(row[COL.name]);
    const bn = byNum.get(set);
    if (!bn.has(nk)) bn.set(nk, []);
    bn.get(nk).push(row);
    const bm = byName.get(set);
    if (!bm.has(nm)) bm.set(nm, []);
    bm.get(nm).push(row);
  }

  const stats = {
    catalogue_cards: 0, mapped: 0, mapped_by_name: 0, priced: 0,
    unmapped_set: 0, name_mismatch: 0, no_card: 0,
    // How the priced cards are priced: from the NM English copy, or from the
    // guide and why (marketPriceOf's nm_en_fallback). And the two by-hand
    // outcomes the cross-check adds.
    nm_en_priced: 0, on_guide: {}, prices_disagree: 0, product_unconfirmed: 0,
  };
  const unmappedSets = new Map();
  const byCatalogueKey = new Map();
  const catalogueSetIds = new Set();

  const entries = cardDb instanceof Map ? cardDb : new Map(Object.entries(cardDb || {}));

  // How many catalogue cards in each set share a folded name, for the
  // name-only fallback below (it is only safe when the name is unique).
  const catNameCount = new Map();
  for (const [key, v] of entries) {
    const dash = key.lastIndexOf('-');
    if (dash < 1 || /_[A-Z]$/i.test(key)) continue;
    const k = key.slice(0, dash) + '|' + normName(v?.name);
    catNameCount.set(k, (catNameCount.get(k) || 0) + 1);
  }

  for (const [key, v] of entries) {
    const dash = key.lastIndexOf('-');
    if (dash < 1) continue;
    const setId = key.slice(0, dash);
    const num = key.slice(dash + 1);
    catalogueSetIds.add(setId);
    stats.catalogue_cards += 1;

    const tset = tcgdexSetFor(setId, tcgdexSetIds);
    if (!tset) {
      stats.unmapped_set += 1;
      unmappedSets.set(setId, (unmappedSets.get(setId) || 0) + 1);
      continue;
    }

    const nk = normCardNumber(num.replace(/_[A-Z]$/i, ''));
    let hit = null;
    let sawNumber = false;
    for (const s of [tset, ...(SECONDARY_SETS[setId] || [])]) {
      const rows = byNum.get(s)?.get(nk);
      if (!rows) continue;
      sawNumber = true;
      hit = rows.find((r) => namesAgree(r[COL.name], v?.name));
      if (hit) break;
    }
    let how = 'number';
    if (!hit) {
      // Numbers that do not line up between the two sources (Classic
      // Collection: CC002 vs 4). Accept a name only when it is unique in BOTH.
      const rows = byName.get(tset)?.get(normName(v?.name));
      const sameNameInCatalogue = catNameCount.get(setId + '|' + normName(v?.name)) || 0;
      if (rows && rows.length === 1 && sameNameInCatalogue <= 1) {
        hit = rows[0];
        how = 'name';
      }
    }
    if (!hit) {
      if (sawNumber) stats.name_mismatch += 1;
      else stats.no_card += 1;
      continue;
    }
    byCatalogueKey.set(key, hit);
    stats.mapped += 1;
    if (how === 'name') stats.mapped_by_name += 1;
    const mp = marketPriceOf(hit);
    if (mp.value != null) {
      stats.priced += 1;
      if (mp.basis === 'nm_en') stats.nm_en_priced += 1;
      else stats.on_guide[mp.nm_en_fallback] = (stats.on_guide[mp.nm_en_fallback] || 0) + 1;
    } else if (mp.reason === 'prices_disagree' || mp.reason === 'product_unconfirmed') {
      stats[mp.reason] += 1;
    }
  }

  // Augmentation: hub sets the catalogue does not have yet.
  const augment = new Map();
  const augmentPrices = new Map();
  const augmented = {};
  for (const [tset, meta] of Object.entries(AUGMENT_SETS)) {
    if (catalogueSetIds.has(meta.id)) continue; // the catalogue has it now
    const rows = byNum.get(tset);
    if (!rows) continue;
    let n = 0;
    for (const [nk, list] of rows) {
      const row = list[0];
      const key = `${meta.id}-${nk}`;
      augment.set(key, {
        name: row[COL.name],
        setName: meta.name,
        setCode: meta.code,
        augmented: true,
      });
      augmentPrices.set(key, row);
      n += 1;
    }
    augmented[meta.id] = n;
  }

  // Classic Collection reprints, keyed by what is PRINTED on them: the
  // original name and number. A typed line that resolves to the original is
  // indistinguishable from one describing the reprint, so it has to be asked.
  const reprints = new Map();
  const addReprint = (name, number, entry) => {
    const k = normName(name) + '|' + normCardNumber(number);
    if (!reprints.has(k)) reprints.set(k, []);
    const list = reprints.get(k);
    if (!list.some((e) => e.reprint_set === entry.reprint_set)) list.push(entry);
  };
  for (const [key, v] of entries) {
    if (!key.startsWith('cel25c-') || /_[A-Z]$/i.test(key)) continue;
    const num = key.slice(key.lastIndexOf('-') + 1);
    addReprint(v?.name, num, {
      reprint_set: 'cel25c',
      label: 'Celebrations Classic Collection reprint (2021, 25th anniversary stamp)',
      key,
      name: v?.name,
      set_name: v?.setName ?? 'Celebrations: Classic Collection',
      card_number: num,
      row: byCatalogueKey.get(key) ?? null,
    });
  }
  for (const r of reprintList) {
    const rows = byName.get(r.tcgdex_set ?? '30th-c')?.get(normName(r.name));
    addReprint(r.name, r.number, {
      reprint_set: r.set_id,
      label: r.label,
      key: `${r.set_id}-${r.number}`,
      name: r.name,
      set_name: r.set_name,
      card_number: String(r.number),
      row: rows && rows.length === 1 ? rows[0] : null,
    });
  }

  return {
    snapshotDate: feed?.snapshot_date ?? null,
    nmEnDate: feed?.nm_en_date ?? null,
    cacheBuiltAt: feed?.cache_built_at ?? feed?.generated_at ?? null,
    feedCards: cards.length,
    byCatalogueKey,
    augment,
    augmentPrices,
    augmented,
    reprints,
    stats: {
      ...stats,
      mapped_ratio: stats.catalogue_cards ? stats.mapped / stats.catalogue_cards : null,
      priced_ratio: stats.catalogue_cards ? stats.priced / stats.catalogue_cards : null,
      nm_en_ratio: stats.priced ? stats.nm_en_priced / stats.priced : null,
      unmapped_sets: Object.fromEntries([...unmappedSets].sort((a, b) => b[1] - a[1])),
    },
  };
}

/** The price row for a catalogue (or augmented) card key, or null. */
export function priceRowFor(index, key) {
  if (!index || !key) return null;
  return index.byCatalogueKey.get(key) ?? index.augmentPrices.get(key) ?? null;
}

/** Reprints whose printed name + number match this card, if any. */
export function reprintsFor(index, name, number) {
  if (!index?.reprints) return [];
  return index.reprints.get(normName(name) + '|' + normCardNumber(number)) ?? [];
}
