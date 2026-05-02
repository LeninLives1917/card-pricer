// Public surface of @card-pricer/shared.
// Pure TypeScript — no runtime side effects, no DOM, no Node-only APIs.

// Top-level re-exports for ergonomic single-import usage.
export {
  arbitrageVariants,
  bestArbitrage,
  singleVariantArbitrage,
} from './arbitrage/index.js';
export type {
  ArbitrageDirection,
  ArbitrageVariant,
  CardPriceEntry,
} from './arbitrage/types.js';

export {
  brevoSendEmail,
  subscribeBrevo,
  subscribeMailchimp,
  subscribeConvertKit,
} from './email/index.js';
export type {
  BrevoConfig,
  BrevoSendArgs,
  NewsletterProvider,
  SubscribeArgs,
  SubscribeResult,
} from './email/index.js';

export { customerQuoteHtml, shopLeadHtml, offerEmailHtml } from './email/templates.js';
export type { QuoteCardRow, QuoteEmailArgs, OfferEmailArgs } from './email/templates.js';

export { hashIp } from './hash.js';

// Identify pipeline.
export {
  PKM_SET_ALIASES,
  POKEMONTCG_UNRELIABLE,
  SET_TOTALS,
  resolveSetCode,
  scoreCandidate,
  extractPokemonSuffix,
  prefetchRefImage,
  verifyPokemon,
} from './identify/index.js';
export type { IdCard, PtcgCandidate, VerifyResult, VerifyOptions } from './identify/index.js';

// Namespaced for callers that prefer dot-notation.
export * as arbitrage from './arbitrage/index.js';
export * as email from './email/index.js';
export * as emailTemplates from './email/templates.js';
export * as identify from './identify/index.js';
