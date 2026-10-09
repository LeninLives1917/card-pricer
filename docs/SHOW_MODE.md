# Show mode (trade-show QR quote)

Built 9 Oct 2026 at Dave's request: a show version of the customer quote where
customers list their cards on their own phone and get their offer in person.

## Links (shop slug `brewed`)

| Who | URL |
|---|---|
| Customer (the QR points here) | https://card-pricer-60qq.onrender.com/show/brewed |
| Staff board | https://card-pricer-60qq.onrender.com/show/brewed/staff |
| Printable A4 poster with the QR | https://card-pricer-60qq.onrender.com/show/brewed/poster |

## Flow

1. Customer scans the QR, types first name, cards (one per line, `3x`, `rev`,
   `lp` work as on the website), optional email and newsletter opt-in.
2. They get a ticket number and "Please visit the counter for your offer",
   with their lines marked recognised / we'll check with you. **No prices.**
3. Staff open the board (sign in with the shop's scanner account; owner or
   admin only). New tickets appear within 5 s. Open one: every line priced
   (cheapest NM English on Cardmarket, as the website), totals in store credit,
   cash and market. Set each card's condition once seen, settle "which one is
   it?" lines, then **Bought** or **Didn't sell**.

## Added 9 Oct 2026 (Liam, Ireland Card Show)

- **Type in a list at the desk.** "+ Type in a list and price it" on the staff
  board (`POST /api/show/:slug/staff/new`, owner or admin). Saved as a ticket
  like a customer's, so Bought / Didn't sell work the same. Counted in
  `/api/health` → `show.by_source.staff`.
- **All the prices for a card.** "Details" on a priced line (or "Show all
  details") shows every Cardmarket number the feed holds: cheapest NM English,
  trend, 7-day and 30-day averages, average sale, lowest listed, which one was
  used and why, the condition adjustment, and a Cardmarket link. Comes from
  `guideOf()` in `pricing/quote-prices/feed-index.js`, carried as
  `price.guide` on each quote row. Lists saved before this need Reprice to show
  it.
- **Softer look, each shop's own branding.** Customer page, staff board and
  poster use a light, rounded palette. Shop name, logo and accent come from the
  shop's settings (accent is calmed in the page so a loud colour stays soft).
  The B&B logo only shows for `brewed`.

## How it is built

- `apps/server/routes/show.js` routes, `pricing/show/offer.js` arithmetic and
  the two views, `apps/show/*.html` pages, table `show_submissions`
  (migration `20261009170000`, RLS on, service role only).
- Pricing is `handleQuoteBatch` called in-process: same engine as the website,
  no HTTP hop, no per-IP rate limit. Submissions are limited to 120/hour per
  address (`showSubmitLimiter`), since a show hall's WiFi shares one.
- The customer view is an allow-list (`customerView`), pinned by
  `tests/regression/show-mode.spec.js`, which fails if any customer body
  carries a price.
- A list saved without prices (catalogue loading, prices stale) still sends
  the customer to the counter; it is counted in `/api/health` → `show` and
  flagged "Not priced" on the board, where **Reprice** fixes it.
