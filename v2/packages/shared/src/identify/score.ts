// Pure scoring of one pokemontcg.io candidate against the AI's identification.
// Direct port of v1's scoreCandidate. The race + 150ms grace logic that
// uses this lives in verify-pokemon.ts.

import { SET_TOTALS } from './set-tables.js';

export interface IdCard {
  name: string;
  hp?: string;
  card_number?: string;
  set_code?: string;
  set_name?: string;
  attacks?: Array<string | { name: string }>;
  regulation_mark?: string;
}

export interface PtcgCandidate {
  id: string;
  name: string;
  hp?: string;
  number?: string;
  set?: { id?: string; name?: string; printedTotal?: number; total?: number };
  rarity?: string;
  images?: { large?: string; small?: string };
  cardmarket?: { url?: string };
  tcgplayer?: { url?: string };
  attacks?: Array<{ name?: string }>;
  abilities?: Array<{ name?: string }>;
}

const POKEMON_SUFFIXES = ['ex', 'GX', 'V', 'VMAX', 'VSTAR', 'EX', 'LV.X'] as const;

export function extractPokemonSuffix(name: string | undefined): string | null {
  if (!name) return null;
  for (const s of POKEMON_SUFFIXES) {
    if (new RegExp(`\\b${s}\\b\\s*$`, 'i').test(name)) return s.toUpperCase();
  }
  return null;
}

/** True when the candidate's set printed-total matches the AI's reg-mark era. */
export function regMarkMatchesEra(regMark: string, candidate: PtcgCandidate): boolean {
  // Heuristic: the regulation-mark era was introduced in 2023 (SV onward). We
  // can sanity-check by looking at the set ID prefix.
  const setId = candidate.set?.id ?? '';
  // SV sets start with 'sv', ME sets with 'me'. Older sets predate reg marks.
  if (regMark === 'G' || regMark === 'H') return /^(sv|me)/.test(setId);
  if (regMark === 'F') return /^swsh1[0-2]|swsh[0-9]/.test(setId);
  if (regMark === 'E' || regMark === 'D') return /^swsh|^sm/.test(setId);
  return true; // unknown reg mark — don't penalise
}

/**
 * Score one candidate. Higher = better match. Used by the race-with-grace
 * pattern in verify-pokemon: first candidate scoring ≥ 220 triggers a 150ms
 * grace window; any query finishing inside that window can still win.
 */
export function scoreCandidate(card: IdCard, isPromo: boolean, d: PtcgCandidate): number {
  let score = 0;

  // Name match — exact name is critical ("Charizard ex" ≠ "Charizard GX")
  if (d.name?.toLowerCase() === card.name?.toLowerCase()) score += 50;
  else if (d.name?.toLowerCase().includes(card.name?.toLowerCase() ?? '')) score += 20;

  // HP match — strong signal
  if (card.hp && d.hp === card.hp) score += 40;
  else if (card.hp && d.hp) {
    const diff = Math.abs(Number.parseInt(d.hp, 10) - Number.parseInt(card.hp, 10));
    if (diff <= 10) score += 20;
  }

  // Card number — HIGHEST priority
  if (card.card_number) {
    const rawAi = card.card_number.replace(/\s/g, '');
    const aiNum = rawAi.replace(/\/.*/, '').replace(/^0+/, '');
    const dbNum = (d.number ?? '').replace(/^0+/, '');
    const aiNumNoSV = aiNum.replace(/^SV/, '');
    if (aiNum === dbNum || rawAi === d.number) score += 80;
    else if (aiNumNoSV === dbNum) score += 70;
    else if (isPromo && aiNum.length > 0 && dbNum.length > 0) score -= 40;
    else if (aiNum.length > 0 && dbNum.length > 0) score -= 10;
  }

  // Abilities (pokemontcg.io has separate abilities + attacks arrays)
  if (card.attacks?.length && d.abilities?.length) {
    const aiAbs = card.attacks.map((a) => (typeof a === 'string' ? a : '').toLowerCase());
    const dbAbs = d.abilities.map((a) => (a.name ?? '').toLowerCase());
    const matches = aiAbs.filter((a) => dbAbs.some((da) => da.includes(a) || a.includes(da)));
    score += matches.length * 15;
  }

  // Set total — if AI says "44/101", set must be ~101 cards
  if (card.card_number && card.card_number.includes('/')) {
    const parts = card.card_number.split('/');
    const aiTotal = Number.parseInt((parts[1] ?? '').replace(/^0+/, '') || '0', 10);
    const dbTotal = Number.parseInt(
      String(d.set?.printedTotal ?? d.set?.total ?? '0'),
      10,
    );
    if (aiTotal && dbTotal) {
      if (aiTotal === dbTotal) score += 50;
      else {
        const diff = Math.abs(aiTotal - dbTotal);
        if (diff <= 2) score += 20;
        else if (diff <= 10) score -= 30;
        else score -= 80;
      }
    }
  }

  // Set code match
  if (card.set_code && d.set?.id?.toUpperCase() === card.set_code.toUpperCase()) score += 25;

  // Set name (fuzzy)
  if (card.set_name && d.set?.name) {
    const aiSet = card.set_name.toLowerCase().replace(/^ex\s+/i, '');
    const dbSet = d.set.name.toLowerCase().replace(/^ex\s+/i, '');
    if (aiSet === dbSet) score += 25;
    else if (dbSet.includes(aiSet) || aiSet.includes(dbSet)) score += 15;
  }

  // Attack names
  if (card.attacks?.length && d.attacks?.length) {
    const aiAtks = card.attacks.map((a) => (typeof a === 'string' ? a : a.name ?? '').toLowerCase());
    const dbAtks = d.attacks.map((a) => (a.name ?? '').toLowerCase());
    const matches = aiAtks.filter((a) => dbAtks.some((da) => da.includes(a) || a.includes(da)));
    score += matches.length * 15;
  }

  // Suffix type match
  const aiSuffix = extractPokemonSuffix(card.name);
  const dbSuffix = extractPokemonSuffix(d.name);
  if (aiSuffix && dbSuffix && aiSuffix === dbSuffix) score += 35;
  else if (aiSuffix && dbSuffix && aiSuffix !== dbSuffix) score -= 50;

  // Regulation-mark era check
  if (card.regulation_mark && !regMarkMatchesEra(card.regulation_mark, d)) {
    score -= 100;
  }

  void SET_TOTALS; // imported for downstream consumers; silence unused-import lint
  return score;
}
