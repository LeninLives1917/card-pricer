// Pokemon verification — port of v1's verifyPokemon. Race-with-grace pattern:
// fire all queries in parallel, score results as each query resolves, exit
// early when any query yields a candidate with score ≥ 220 + a 150ms grace
// window so any near-finished query also gets to score.

import { resolveSetCode } from './set-tables.js';
import { scoreCandidate, type IdCard, type PtcgCandidate } from './score.js';

export interface VerifyResult {
  name: string;
  set_name: string;
  set_code: string;
  card_number: string;
  rarity?: string;
  hp?: string;
  reference_image?: string;
  cardmarket_url?: string | null;
  tcgplayer_url?: string | null;
  source: string;
  confidence_score: number;
  /** Top runners-up for a chooser UI when confidence is moderate. */
  candidates: Array<{
    name: string;
    set_name: string;
    set_code: string;
    card_number: string;
    rarity: string;
    hp: string;
    image: string | null;
    cardmarket_url: string | null;
    tcgplayer_url: string | null;
    score: number;
  }>;
  /** In-flight ref-image fetch — consumed by maybeDoubleCheck if confidence < 200. */
  _refImagePromise?: Promise<{ data?: ArrayBuffer; _failed?: string } | null>;
}

const RACE_THRESHOLD = 220;
const GRACE_MS = 150;

export interface VerifyOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/** Verify a Pokemon card identification against pokemontcg.io. */
export async function verifyPokemon(
  card: IdCard,
  options: VerifyOptions = {},
): Promise<VerifyResult | null> {
  const apiKey = options.apiKey ?? process.env.POKEMON_TCG_API_KEY;
  const f = options.fetchImpl ?? fetch;

  // Detect promo (no slash in number, all-letters-then-digits format)
  const isPromo =
    !!card.card_number &&
    !card.card_number.includes('/') &&
    /^[A-Z]{2,}P?\d+$/i.test(card.card_number.replace(/\s/g, ''));

  const queries = buildQueries(card, isPromo);

  const seenIds = new Set<string>();
  const allScored: Array<{ d: PtcgCandidate; score: number }> = [];
  let globalBest: PtcgCandidate | null = null;
  let globalBestScore = -1;

  // Fire all queries in parallel and score each as it resolves.
  const promises = queries.map((q) =>
    f(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&pageSize=20`, {
      headers: apiKey ? { 'X-Api-Key': apiKey } : {},
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (r) => {
        if (!r.ok) return { q, queryBestScore: -1 };
        const data = (await r.json()) as { data?: PtcgCandidate[] };
        const results = data.data ?? [];
        let queryBestScore = -1;
        for (const d of results) {
          if (seenIds.has(d.id)) continue;
          seenIds.add(d.id);
          const score = scoreCandidate(card, isPromo, d);
          allScored.push({ d, score });
          if (score > globalBestScore) {
            globalBestScore = score;
            globalBest = d;
          }
          if (score > queryBestScore) queryBestScore = score;
        }
        return { q, queryBestScore };
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[VERIFY-PKM] query failed "${q}": ${msg}`);
        return { q, queryBestScore: -1 };
      }),
  );

  // Race: trigger 150ms grace when first query crosses RACE_THRESHOLD,
  // otherwise wait for everything to settle.
  await new Promise<void>((resolveOuter) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolveOuter();
      }
    };
    promises.forEach((p) =>
      p.then((r) => {
        if (done || !r) return;
        if (r.queryBestScore >= RACE_THRESHOLD) {
          setTimeout(finish, GRACE_MS);
        }
      }),
    );
    Promise.allSettled(promises).then(finish);
  });

  if (!globalBest || globalBestScore < 120) return null;

  const candidates = allScored
    .filter((x) => x.score >= 40 && x.d.id !== globalBest!.id)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ d, score }) => ({
      name: d.name,
      set_name: d.set?.name ?? '',
      set_code: d.set?.id?.toUpperCase() ?? '',
      card_number: d.number ?? '',
      rarity: d.rarity ?? '',
      hp: d.hp ?? '',
      image: d.images?.small ?? d.images?.large ?? null,
      cardmarket_url: d.cardmarket?.url ?? null,
      tcgplayer_url: d.tcgplayer?.url ?? null,
      score,
    }));

  // Cast for narrowing (TS thinks globalBest could still be null inside callbacks).
  const best = globalBest as PtcgCandidate;
  const refUrl = best.images?.large ?? best.images?.small;

  return {
    name: best.name,
    set_name: best.set?.name ?? '',
    set_code: best.set?.id?.toUpperCase() ?? '',
    card_number: best.number ?? '',
    rarity: best.rarity,
    hp: best.hp,
    reference_image: refUrl,
    cardmarket_url: best.cardmarket?.url ?? null,
    tcgplayer_url: best.tcgplayer?.url ?? null,
    source: 'pokemontcg.io',
    confidence_score: globalBestScore,
    candidates,
    _refImagePromise: globalBestScore < 200 && refUrl ? prefetchRefImage(refUrl, f) : undefined,
  };
}

function buildQueries(card: IdCard, isPromo: boolean): string[] {
  const queries: string[] = [];

  if (isPromo && card.card_number) {
    const promoNum = card.card_number.replace(/\s/g, '');
    queries.push(`number:${promoNum}`);
    queries.push(`name:"${card.name}" number:${promoNum}`);
  }

  // Attack-name primacy
  if (card.attacks?.length) {
    const atk = card.attacks
      .map((a) => (typeof a === 'string' ? a : a?.name ?? ''))
      .find((s) => s && s.length > 2);
    if (atk) queries.push(`name:"${card.name}" attacks.name:"${atk.replace(/"/g, '')}"`);
  }

  // Set-total primacy
  if (card.card_number?.includes('/')) {
    const parts = card.card_number.split('/');
    const total = (parts[1] ?? '').replace(/^0+/, '');
    const num = (parts[0] ?? '').replace(/^0+/, '');
    if (total && num) {
      queries.push(`name:"${card.name}" set.printedTotal:${total} number:${num}`);
    }
  }

  // Exact set + number
  if (card.card_number && card.set_code) {
    const num = card.card_number.replace(/\/.*/, '');
    queries.push(`name:"${card.name}" set.id:${card.set_code.toLowerCase()} number:${num}`);
    const resolved = resolveSetCode(card.set_code);
    if (resolved.setId && resolved.setId !== card.set_code.toLowerCase()) {
      queries.push(`name:"${card.name}" set.id:${resolved.setId} number:${num}`);
    }
  }

  // Number alone
  if (card.card_number) {
    const num = card.card_number.replace(/\/.*/, '');
    queries.push(`name:"${card.name}" number:${num}`);
  }

  // HP-based
  if (card.hp) queries.push(`name:"${card.name}" hp:${card.hp}`);

  // Name fallback
  queries.push(`name:"${card.name}"`);

  return queries;
}

/** Start fetching a candidate's reference image. Resolves with the buffer
    on success, or `{_failed: msg}` on error — never throws. */
export function prefetchRefImage(
  url: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ data?: ArrayBuffer; _failed?: string } | null> {
  if (!url) return Promise.resolve(null);
  return fetchImpl(url, { signal: AbortSignal.timeout(8_000) })
    .then(async (r) => {
      if (!r.ok) return { _failed: `HTTP ${r.status}` };
      return { data: await r.arrayBuffer() };
    })
    .catch((e: unknown) => ({
      _failed: e instanceof Error ? e.message : String(e),
    }));
}
