// Public surface of the identify pipeline.

export {
  PKM_SET_ALIASES,
  POKEMONTCG_UNRELIABLE,
  SET_TOTALS,
  resolveSetCode,
} from './set-tables.js';

export {
  extractPokemonSuffix,
  regMarkMatchesEra,
  scoreCandidate,
  type IdCard,
  type PtcgCandidate,
} from './score.js';

export {
  prefetchRefImage,
  verifyPokemon,
  type VerifyOptions,
  type VerifyResult,
} from './verify-pokemon.js';
