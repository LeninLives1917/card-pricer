// pricing/corrections.js
//
// Owner: A2 (Pricing engine) — Slice S6
// Cross-references:
//   - docs/V2_AUDIT.md §5.4 (Pokellector overrides ALWAYS win)
//   - docs/V2_AUDIT.md §5.5 (POKEMONTCG_UNRELIABLE skip list)
//   - V1 server.js:1563-1628 (Pokellector corrections — verbatim)
//   - V1 server.js:1535-1540 (POKEMONTCG_UNRELIABLE)
//   - V1 server.js:1543-1548 (REG_MARK_ERAS) and :3504-3517 (regMarkMatchesEra)
//
// VERBATIM extraction from V1 server.js. Mutating any value here re-introduces
// a wrong-correction bug class (e.g. the Bulbasaur Expedition #94 → ME1 #1
// regression). Tied to RG-06, RG-07, RG-26, RG-28, RG-29.

/**
 * Hardcoded Pokellector overrides for sets where pokemontcg.io's data is
 * known-bad (typically because Pokellector publishes earlier than the
 * pokemontcg.io re-pull cycle). Source priority: 'pokellector' ALWAYS beats
 * 'manual' / 'sheet' / 'tcggo' / 'pokemontcg' (V1 addCardToDb).
 */
export const POKELLECTOR_CORRECTIONS = {
  'me1': {
    setName: 'Mega Evolution', setCode: 'ME1',
    cards: {
      1:'Bulbasaur',2:'Ivysaur',3:'Mega Venusaur ex',4:'Exeggcute',5:'Exeggutor',
      6:'Tangela',7:'Tangrowth',8:'Chikorita',9:'Bayleef',10:'Meganium',
      11:'Shuckle',12:'Celebi',13:'Seedot',14:'Nuzleaf',15:'Shiftry',
      16:'Nincada',17:'Ninjask',18:'Dhelmise',19:'Vulpix',20:'Ninetales',
      21:'Numel',22:'Mega Camerupt ex',23:'Litleo',24:'Pyroar',25:'Volcanion',
      26:'Scorbunny',27:'Raboot',28:'Cinderace',29:'Sizzlipede',30:'Centiskorch',
      31:'Chi-Yu',32:'Mantine',33:'Corphish',34:'Kyogre',35:'Snover',
      36:'Mega Abomasnow ex',37:'Clauncher',38:'Clawitzer',39:'Sobble',40:'Drizzile',
      41:'Inteleon',42:'Snom',43:'Frosmoth',44:'Eiscue',45:'Magnemite',
      46:'Magneton',47:'Magnezone',48:'Raikou',49:'Electrike',50:'Mega Manectric ex',
      51:'Pachirisu',52:'Helioptile',53:'Heliolisk',54:'Abra',55:'Kadabra',
      56:'Alakazam',57:'Jynx',58:'Ralts',59:'Kirlia',60:'Mega Gardevoir ex',
      61:'Shedinja',62:'Spoink',63:'Grumpig',64:'Xerneas',65:'Greavard',
      66:'Houndstone',67:'Gimmighoul',68:'Sandshrew',69:'Sandslash',70:'Onix',
      71:'Tyrogue',72:'Makuhita',73:'Hariyama',74:'Lunatone',75:'Solrock',
      76:'Riolu',77:'Mega Lucario ex',78:'Croagunk',79:'Toxicroak',80:'Marshadow',
      81:'Stonjourner',82:'Nacli',83:'Naclstack',84:'Garganacl',85:'Crawdaunt',
      86:'Mega Absol ex',87:'Spiritomb',88:'Yveltal',89:'Nickit',90:'Thievul',
      91:'Shroodle',92:'Grafaiai',93:'Steelix',94:'Mega Mawile ex',95:'Dialga',
      96:'Tinkatink',97:'Tinkatuff',98:'Tinkaton',99:'Gholdengo',100:'Mega Latias ex',
      101:'Latios',102:'Spearow',103:'Fearow',104:'Mega Kangaskhan ex',105:'Delibird',
      106:'Miltank',107:'Buneary',108:'Lopunny',109:'Yungoos',110:'Gumshoos',
      111:'Stufful',112:'Bewear',113:"Acerola's Mischief",114:'Boss\'s Orders [Ghetsis]',
      115:'Energy Switch',116:'Fighting Gong',117:'Forest of Vitality',118:'Iron Defender',
      119:"Lillie's Determination",120:"Lt. Surge's Bargain",121:'Mega Signal',
      122:'Mystery Garden',123:'Pokémon Center Lady',124:'Premium Power Pro',
      125:'Rare Candy',126:'Repel',127:'Risky Ruins',128:'Strange Timepiece',
      129:'Surfing Beach',130:'Switch',131:'Ultra Ball',132:"Wally's Compassion",
      133:'Bulbasaur',134:'Ivysaur',135:'Exeggutor',136:'Shuckle',137:'Ninjask',
      138:'Vulpix',139:'Litleo',140:'Snover',141:'Clawitzer',142:'Inteleon',
      143:'Helioptile',144:'Shedinja',145:'Houndstone',146:'Marshadow',147:'Garganacl',
      148:'Spiritomb',149:'Shroodle',150:'Steelix',151:'Spearow',152:'Delibird',
      153:'Gumshoos',154:'Stufful',155:'Mega Venusaur ex',156:'Mega Camerupt ex',
      157:'Mega Abomasnow ex',158:'Mega Manectric ex',159:'Mega Gardevoir ex',
      160:'Mega Lucario ex',161:'Mega Absol ex',162:'Mega Mawile ex',
      163:'Mega Latias ex',164:'Mega Kangaskhan ex',165:"Acerola's Mischief",
      166:'Air Balloon',167:'Buddy-Buddy Poffin',168:'Fighting Gong',
      169:"Lillie's Determination",170:"Lt. Surge's Bargain",171:'Mega Signal',
      172:'Mystery Garden',173:'Night Stretcher',174:'Premium Power Pro',
      175:'Rare Candy',176:"Wally's Compassion",177:'Mega Venusaur ex',
      178:'Mega Gardevoir ex',179:'Mega Lucario ex',180:'Mega Absol ex',
      181:'Mega Latias ex',182:'Mega Kangaskhan ex',183:"Acerola's Mischief",
      184:"Lillie's Determination",185:"Lt. Surge's Bargain",186:"Wally's Compassion",
      187:'Mega Gardevoir ex',188:'Mega Lucario ex',
    }
  },
  'mep': {
    setName: 'Mega Evolution Promos', setCode: 'MEP',
    cards: {
      1:'Meganium',2:'Inteleon',3:'Alakazam',4:'Lunatone',5:'Drifloon',
      6:'Drifblim',7:'Psyduck',8:'Golduck',9:'Alakazam',10:'Riolu',
      11:'Mega Latias ex',12:'Mega Lucario ex',13:'Mega Venusaur ex',14:'Ceruledge',
      15:'Zacian',16:'Flygon',17:'Toxtricity',18:'Cottonee',19:'Whimsicott',
      20:'Sneasel',21:'Weavile',22:'Charcadet',23:'Mega Charizard ex',24:'Oricorio ex',
      25:'Mega Kangaskhan ex',26:'Meloetta',27:'Haunter',28:'Celebratory Fanfare',
      31:"N's Zekrom",32:'Mega Gardevoir ex',33:'Mega Lucario ex',
      36:'Mega Feraligatr ex',64:'Serperior',65:'Barbaracle',66:'Tyrantrum',
      67:'Doublade',69:'Chikorita',70:'Tyrunt',71:'Mega Zygarde ex',
      74:'Delphox',75:'Ampharos',76:'Crobat',77:'Goodra',78:'Toxel',79:'Charmeleon',
    }
  },
};

/**
 * pokemontcg.io sets where the upstream data has known mismatches with
 * Pokellector + manual / TCGGO imports. lookupLocalDb() requires a trusted
 * source (pokellector / tcggo / fallback / manual) for cards in these sets;
 * processPageData() skips them entirely on the bulk download.
 */
export const POKEMONTCG_UNRELIABLE = new Set([
  'mep', 'me1', 'me2pt5', 'wht', 'bbt',
]);

/**
 * Pokemon regulation-mark → era window. Used both by scoreCandidate (in the
 * Pokemon adapter) to penalise era-mismatched candidates and by the
 * /api/lookup-by-number ambiguity filter.
 *
 * V1 server.js:1543-1548. Year ranges intentionally overlap — printings
 * straddle rotations.
 */
export const REG_MARK_ERAS = {
  'D': { minYear: 2019, maxYear: 2021, prefix: 'swsh' },
  'E': { minYear: 2021, maxYear: 2023, prefix: 'swsh' },
  'F': { minYear: 2022, maxYear: 2024, prefix: 'swsh' },
  'G': { minYear: 2023, maxYear: 2025, prefix: 'sv' },
  'H': { minYear: 2024, maxYear: 2026, prefix: 'sv' },
  'J': { minYear: 2025, maxYear: 2027, prefix: '' },
};

/**
 * Returns true when a pokemontcg.io row's set matches the era hinted by the
 * regulation mark. Either the set id prefix (e.g. 'swsh') or the release
 * year range counts as a match — printings cross rotation boundaries.
 *
 * @param {string|null|undefined} regMark  D/E/F/G/H/J or falsy.
 * @param {object} d                       pokemontcg.io card row.
 */
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
