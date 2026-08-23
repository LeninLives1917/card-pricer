// pricing/set-aliases.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - docs/V2_ARCHITECTURE.md §F23 (consolidate Cardmarket set tables)
//   - V1 server.js:1386-1480 — PKM_SET_ALIASES, PKM_SET_NAMES, TCGDEX_SET_MAP
//   - V1 public/quote.html:427-454 — CM_SET_SLUGS + CM_PTCGO_CODES
//
// VERBATIM extraction. F23 in the V2 feature roster: collapse the Cardmarket
// set-slug tables that lived in BOTH server.js and quote.html into one
// source of truth. The quote.html copy is left in place for the duration of
// S6 — A5 (Quote app) flips quote.html to import from this module in S8.

/**
 * Printed set-code → pokemontcg.io set-id alias map. The set codes printed
 * on cards (PTCGO codes) are usually shorter / different from the IDs
 * pokemontcg.io uses internally. Verify, /api/identify-manual, and
 * /api/lookup-by-number all run user input through resolveSetCode() before
 * touching the upstream API.
 *
 * V1 server.js:1386-1452.
 */
export const PKM_SET_ALIASES = {
  'SVI':  'sv1',        'PAL':  'sv2',        'OBF':  'sv3',
  'MEW':  'sv3pt5',     '151':  'sv3pt5',     'PAR':  'sv4',
  'PAF':  'sv4pt5',     'TEF':  'sv5',        'TWM':  'sv6',
  'SFA':  'sv6pt5',     'SCR':  'sv7',        'SSP':  'sv8',
  'PRE':  'sv8pt5',     'JTG':  'sv9',
  'JT':   'sv9',        'DRI':  'sv10',
  // 'SVE' pointed at sv8pt5 (Prismatic Evolutions), so "SVE 001" priced an
  // Exeggcute. SVE is Scarlet & Violet Energies, which exists as `sve`.
  'SVE':  'sve',
  // These five pointed at `bbt` and `wht`, which are not set ids anywhere —
  // they were hand-entered before upstream published the sets, and upstream
  // then named them zsv10pt5 and rsv10pt5. 345 cards were unreachable, and
  // because the aliases resolved (aliased: true) the ptcgoCode fallback query
  // at identify.js:478 was skipped, so there was no second chance either.
  'BBT':  'zsv10pt5',   'BLK':  'zsv10pt5',   'ZSV10PT5': 'zsv10pt5',
  'WHT':  'rsv10pt5',   'RSV10PT5': 'rsv10pt5',
  'MEG':  'me1',        'ME1':  'me1',        'PFL':  'me2',
  // ASC is the printed code for Ascended Heroes; ASH predates it and is kept
  // so anything already typed still resolves.
  'ME2':  'me2',        'ASC':  'me2pt5',     'ASH':  'me2pt5',
  'POR':  'me3',        'ME3':  'me3',
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
  // 'HIF' pointed at sm35 — Shining Legends, whose code is SLG and which is
  // already mapped two lines up. HIF is Hidden Fates. This one survived every
  // existence check ever run against this table, because sm35 is a real set
  // full of real cards; only comparing the key against the target's OWN
  // ptcgoCode catches it. See tests/regression/set-alias-reconcile.spec.js.
  'CEC':  'sm12',       'HIF':  'sm115',      'DET':  'det1',
  'XY':   'xy1',        'FLF':  'xy2',        'FFI':  'xy3',
  'PHF':  'xy4',        'PRC':  'xy5',        'ROS':  'xy6',
  'AOR':  'xy7',        'BKT':  'xy8',        'BKP':  'xy9',
  'FCO':  'xy10',       'STS':  'xy11',       'EVO':  'xy12',
  'GEN':  'g1',
};

/**
 * pokemontcg.io set-id → human-readable set name. Used by importer +
 * fallback adapters when an upstream returns no set name of its own.
 *
 * V1 server.js:1454-1480.
 */
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

/**
 * pokemontcg.io set-id → tcgdex.net set-id. tcgdex uses a slightly different
 * naming scheme (zero-padded, dotted minor versions). Verify-only adapter
 * pricing/adapters/tcgdex.js consults this map.
 *
 * V1 server.js:1488-1499.
 */
export const TCGDEX_SET_MAP = {
  'sv1':  'sv01', 'sv2':  'sv02', 'sv3':  'sv03', 'sv3pt5': 'sv03.5',
  'sv4':  'sv04', 'sv4pt5': 'sv04.5', 'sv5':  'sv05', 'sv6':  'sv06',
  'sv6pt5': 'sv06.5', 'sv7':  'sv07', 'sv8':  'sv08', 'sv8pt5': 'sv08.5',
  'sv9':  'sv09', 'sv10': 'sv10',
  'svp':  'svp',  'mep':  'svp',
  'me1':  'sv04.5', 'me2':  'sv05.5', 'me3': 'sv06.5',
  'wht':  'sv10.5', 'bbt':  'sv10.5',
};

// ============================================================================
// Cardmarket URL builders — F23 consolidation (V2_ARCHITECTURE).
// V1 lived in public/quote.html:427-454. The quote app keeps an inline copy
// during S6 → S8 migration; A5 flips it in S8.
// ============================================================================

/**
 * pokemontcg.io set-id → Cardmarket URL slug (the path segment after
 * `/Pokemon/Products/Singles/`).
 */
export const CM_SET_SLUGS = {
  // SV era
  'sv1': 'Scarlet-Violet', 'sv2': 'Paldea-Evolved', 'sv3': 'Obsidian-Flames',
  'sv3pt5': '151', 'sv4': 'Paradox-Rift', 'sv4pt5': 'Paldean-Fates',
  'sv5': 'Temporal-Forces', 'sv6': 'Twilight-Masquerade', 'sv6pt5': 'Shrouded-Fable',
  'sv7': 'Stellar-Crown', 'sv8': 'Surging-Sparks', 'sv8pt5': 'Prismatic-Evolutions',
  'sv9': 'Journey-Together', 'sv10': 'Destined-Rivals',
  'me1': 'Mega-Evolution', 'me2': 'Phantasmal-Flames', 'me3': 'Perfect-Order',
  'svp': 'SV-Black-Star-Promos',
  // SwSh era
  'swsh1': 'Sword-Shield', 'swsh2': 'Rebel-Clash', 'swsh3': 'Darkness-Ablaze',
  'swsh4': 'Vivid-Voltage', 'swsh5': 'Battle-Styles', 'swsh6': 'Chilling-Reign',
  'swsh7': 'Evolving-Skies', 'swsh8': 'Fusion-Strike', 'swsh9': 'Brilliant-Stars',
  'swsh10': 'Astral-Radiance', 'swsh11': 'Lost-Origin', 'swsh12': 'Silver-Tempest',
  'swsh12pt5': 'Crown-Zenith', 'swsh35': 'Champions-Path', 'swsh45': 'Shining-Fates',
};

/**
 * pokemontcg.io set-id → uppercase PTCGO code (Cardmarket sometimes wants
 * the printed code segment). Inverse of PKM_SET_ALIASES restricted to the
 * sets the customer-quote app cares about.
 */
export const CM_PTCGO_CODES = {
  'sv1': 'SVI', 'sv2': 'PAL', 'sv3': 'OBF', 'sv3pt5': 'MEW',
  'sv4': 'PAR', 'sv4pt5': 'PAF', 'sv5': 'TEF', 'sv6': 'TWM',
  'sv6pt5': 'SFA', 'sv7': 'SCR', 'sv8': 'SSP', 'sv8pt5': 'PRE',
  'sv9': 'JTG', 'sv10': 'DRI',
  'me1': 'MEG', 'me2': 'PFL', 'me3': 'POR',
  'svp': 'SVP',
  'swsh1': 'SSH', 'swsh2': 'RCL', 'swsh3': 'DAA', 'swsh4': 'VIV',
  'swsh5': 'BST', 'swsh6': 'CRE', 'swsh7': 'EVS', 'swsh8': 'FST',
  'swsh9': 'BRS', 'swsh10': 'ASR', 'swsh11': 'LOR', 'swsh12': 'SIT',
  'swsh12pt5': 'CRZ', 'swsh35': 'CPA', 'swsh45': 'SHF',
};

/**
 * Resolve a printed set code into a pokemontcg.io set-id + the original
 * upper-cased PTCGO code. Returns `aliased: true` when the alias map fired,
 * so callers can decide whether to also try the original case.
 *
 * V1 server.js:3475-3486.
 *
 * @param {string|null|undefined} raw  Printed set code, e.g. "MEG", "SSP".
 * @returns {{ setId: string|null, ptcgoCode: string|null, aliased: boolean }}
 */
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
