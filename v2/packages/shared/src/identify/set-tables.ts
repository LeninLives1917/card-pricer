// Pokemon set-code aliases and printed totals.
// Direct port of v1's PKM_SET_ALIASES + SET_TOTALS + POKEMONTCG_UNRELIABLE.
// These are hard-won data — a card-shop staff member typing "MEG" should
// resolve to set ID "me1", and we should know that "POR" is "me3".

/** User-typed set codes (PTCGO codes, abbreviations) → pokemontcg.io set IDs. */
export const PKM_SET_ALIASES: Record<string, string> = {
  // Mega Evolution era (2025+)
  MEG: 'me1', MEP: 'me1',
  PFL: 'me2',
  POR: 'me3',
  // Scarlet & Violet era
  SVI: 'sv1', PAL: 'sv2', OBF: 'sv3', MEW: 'sv3pt5',
  PAR: 'sv4', PAF: 'sv4pt5', TEF: 'sv5', TWM: 'sv6',
  SFA: 'sv6pt5', SCR: 'sv7', SSP: 'sv8', PRE: 'sv8pt5',
  JTG: 'sv9', DRI: 'sv10', BBT: 'sv11', WHT: 'sv11',
  SVP: 'svp',
  // Sword & Shield era
  SSH: 'swsh1', RCL: 'swsh2', DAA: 'swsh3', VIV: 'swsh4',
  BST: 'swsh5', CRE: 'swsh6', EVS: 'swsh7', FST: 'swsh8',
  BRS: 'swsh9', ASR: 'swsh10', LOR: 'swsh11', SIT: 'swsh12',
  CRZ: 'swsh12pt5', CPA: 'swsh35', SHF: 'swsh45',
  // Sun & Moon era
  SUM: 'sm1', GRI: 'sm2', BUS: 'sm3', CIN: 'sm4',
  UPR: 'sm5', FLI: 'sm6', CES: 'sm7', LOT: 'sm8',
  TEU: 'sm9', UNB: 'sm10', UNM: 'sm11', CEC: 'sm12',
  DET: 'det1',
  // XY era
  XY: 'xy1', FLF: 'xy2', FFI: 'xy3', PHF: 'xy4',
  PRC: 'xy5', ROS: 'xy6', AOR: 'xy7', BKT: 'xy8',
  BKP: 'xy9', FCO: 'xy10', STS: 'xy11', EVO: 'xy12',
  GEN: 'g1',
};

/** Reverse map: pokemontcg.io set ID → printed total cards in the base set.
   Used to disambiguate alt-arts and secret rares (number > total = secret rare). */
export const SET_TOTALS: Record<string, number> = {
  // Mega Evolution
  me1: 132, me2: 130, me3: 188,
  // Scarlet & Violet
  sv1: 198, sv2: 193, sv3: 197, 'sv3pt5': 165,
  sv4: 182, 'sv4pt5': 91, sv5: 162, sv6: 167,
  'sv6pt5': 64, sv7: 142, sv8: 191, 'sv8pt5': 84,
  sv9: 159, sv10: 182,
  // Sword & Shield
  swsh1: 202, swsh2: 192, swsh3: 189, swsh4: 185,
  swsh5: 163, swsh6: 198, swsh7: 203, swsh8: 264,
  swsh9: 172, swsh10: 189, swsh11: 196, swsh12: 195,
  'swsh12pt5': 159, swsh35: 73, swsh45: 72,
  // Sun & Moon
  sm1: 149, sm2: 145, sm3: 145, sm4: 111, sm5: 156,
  sm6: 131, sm7: 168, sm8: 214, sm9: 209, sm10: 198,
  sm11: 196, sm12: 236, det1: 73,
  // XY
  xy1: 146, xy2: 106, xy3: 119, xy4: 111, xy5: 160,
  xy6: 108, xy7: 98, xy8: 162, xy9: 122, xy10: 124,
  xy11: 114, xy12: 108, g1: 83,
};

/** Sets where pokemontcg.io's data is known-bad — skip verification + bulk DB. */
export const POKEMONTCG_UNRELIABLE = new Set<string>([
  // legacy sets pokemontcg.io confuses with newer reprints
  'base1', 'base2', 'base3', 'base4', 'base5',
  'jungle', 'fossil', 'rocket',
]);

/**
 * Resolve a user-typed set code to an internal pokemontcg.io ID.
 * Tries ALIASES first, then falls back to lowercase identity.
 */
export function resolveSetCode(raw: string | null | undefined): {
  setId: string | null;
  ptcgoCode: string | null;
  aliased: boolean;
} {
  if (!raw) return { setId: null, ptcgoCode: null, aliased: false };
  const upper = String(raw).toUpperCase().trim();
  const lower = String(raw).toLowerCase().trim();
  if (PKM_SET_ALIASES[upper]) {
    return { setId: PKM_SET_ALIASES[upper], ptcgoCode: upper, aliased: true };
  }
  // Already a pokemontcg.io ID format
  if (/^[a-z0-9]+(?:pt\d+)?$/.test(lower)) {
    return { setId: lower, ptcgoCode: null, aliased: false };
  }
  return { setId: null, ptcgoCode: null, aliased: false };
}
