// apps/quote/modules/cardmarket-url.js
// Owner: A5 | Slice: S8
//
// Build a direct Cardmarket product URL for a Pokemon card so the customer
// can verify the live price themselves. Verbatim port of V1
// public/quote.html lines 427-478 (V2_AUDIT §1c, "Honourable mentions" R23
// flags the duplication with server.js — F23 hoists this to one source of
// truth in pricing/set-aliases.js).
//
// The old TODO here said "pricing/set-aliases.js is empty as of S8 commit
// 6af2e32". It is not — it is 171 lines and exports CM_SET_SLUGS and
// CM_PTCGO_CODES. Both tables were compared against the inline ones below:
// 33 keys each, same keys, same values, no drift.
//
// So this is a duplicate that happens to agree, not a duplicate that has
// diverged — which is the good case, and the reason to leave it alone for
// now rather than reach across from apps/quote into pricing/ in a commit
// about something else. It gets unified with the shared typed-entry core,
// where both surfaces move onto one module together and a single reconcile
// test can hold them there. Until then, a change to one table must be made
// to the other; the drift is not currently caught by anything.
//
// URL pattern:
//   /en/Pokemon/Products/Singles/{Set-Slug}/{Card-Slug}-{PtcgoCode}{PaddedNum}
// Falls back to set-filtered search when the set isn't in the table.

export const CM_SET_SLUGS = {
  // SV era
  sv1: 'Scarlet-Violet',
  sv2: 'Paldea-Evolved',
  sv3: 'Obsidian-Flames',
  sv3pt5: '151',
  sv4: 'Paradox-Rift',
  sv4pt5: 'Paldean-Fates',
  sv5: 'Temporal-Forces',
  sv6: 'Twilight-Masquerade',
  sv6pt5: 'Shrouded-Fable',
  sv7: 'Stellar-Crown',
  sv8: 'Surging-Sparks',
  sv8pt5: 'Prismatic-Evolutions',
  sv9: 'Journey-Together',
  sv10: 'Destined-Rivals',
  me1: 'Mega-Evolution',
  me2: 'Phantasmal-Flames',
  me3: 'Perfect-Order',
  svp: 'SV-Black-Star-Promos',
  // SwSh era
  swsh1: 'Sword-Shield',
  swsh2: 'Rebel-Clash',
  swsh3: 'Darkness-Ablaze',
  swsh4: 'Vivid-Voltage',
  swsh5: 'Battle-Styles',
  swsh6: 'Chilling-Reign',
  swsh7: 'Evolving-Skies',
  swsh8: 'Fusion-Strike',
  swsh9: 'Brilliant-Stars',
  swsh10: 'Astral-Radiance',
  swsh11: 'Lost-Origin',
  swsh12: 'Silver-Tempest',
  swsh12pt5: 'Crown-Zenith',
  swsh35: 'Champions-Path',
  swsh45: 'Shining-Fates',
};

export const CM_PTCGO_CODES = {
  sv1: 'SVI',
  sv2: 'PAL',
  sv3: 'OBF',
  sv3pt5: 'MEW',
  sv4: 'PAR',
  sv4pt5: 'PAF',
  sv5: 'TEF',
  sv6: 'TWM',
  sv6pt5: 'SFA',
  sv7: 'SCR',
  sv8: 'SSP',
  sv8pt5: 'PRE',
  sv9: 'JTG',
  sv10: 'DRI',
  me1: 'MEG',
  me2: 'PFL',
  me3: 'POR',
  svp: 'SVP',
  swsh1: 'SSH',
  swsh2: 'RCL',
  swsh3: 'DAA',
  swsh4: 'VIV',
  swsh5: 'BST',
  swsh6: 'CRE',
  swsh7: 'EVS',
  swsh8: 'FST',
  swsh9: 'BRS',
  swsh10: 'ASR',
  swsh11: 'LOR',
  swsh12: 'SIT',
  swsh12pt5: 'CRZ',
  swsh35: 'CPA',
  swsh45: 'SHF',
};

/**
 * Build a Cardmarket direct product URL for a Pokemon card. Returns null
 * for non-Pokemon cards or when no usable set hint is available.
 * @param {{game?:string, set_code?:string, set_name?:string, card_number?:string, name?:string}} card
 * @returns {string|null}
 */
export function buildCardmarketUrl(card) {
  if (!card || card.game !== 'pokemon') return null;
  const setId = String(card.set_code || '').toLowerCase();
  const setSlug = CM_SET_SLUGS[setId];

  if (!setSlug) {
    // Fall back to slugifying the printed set name + searchString filter.
    const fallbackSlug = String(card.set_name || '')
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .replace(/\s+/g, '-');
    if (!fallbackSlug) return null;
    return (
      'https://www.cardmarket.com/en/Pokemon/Products/Singles/' +
      fallbackSlug +
      '?searchString=' +
      encodeURIComponent(card.name || '')
    );
  }

  const ptcgo = CM_PTCGO_CODES[setId] || setId.toUpperCase();
  const num = String(card.card_number || '').replace(/\/.*/, '');
  const padNum = num.padStart(3, '0');
  const nameSlug = String(card.name || 'Unknown')
    .replace(/[':]/g, '')              // apostrophes + colons removed
    .replace(/[^a-zA-Z0-9\s-]/g, '')   // other special chars
    .trim()
    .replace(/\s+/g, '-');

  return (
    'https://www.cardmarket.com/en/Pokemon/Products/Singles/' +
    setSlug +
    '/' +
    nameSlug +
    '-' +
    ptcgo +
    padNum
  );
}
