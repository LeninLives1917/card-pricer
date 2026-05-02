// Email templates as plain TS functions. Server passes data in,
// gets HTML out. No template engine, no Markdown — straight string
// concatenation with the same look as v1's emails.

export interface QuoteCardRow {
  name: string;
  setCode?: string | null;
  marketValue: number;
  cashOffer: number;
  creditOffer: number;
  cardNumber?: string | null;
  conditionEstimate?: string | null;
}

export interface QuoteEmailArgs {
  shopName: string;
  customerName?: string | null;
  cards: QuoteCardRow[];
  totals: { market: number; cash: number; credit: number };
  cashPct: number;
  creditPct: number;
}

const escape = (s: string) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );

const fmt = (n: number) => (n ?? 0).toFixed(2);

/** Customer-facing quote email. */
export function customerQuoteHtml(args: QuoteEmailArgs): string {
  const { shopName, customerName, cards, totals, cashPct, creditPct } = args;
  const rows = cards
    .map(
      (c) => `<tr>
        <td style="padding:8px; border-bottom:1px solid #eee;">${escape(c.name || 'Unknown')}${
          c.setCode ? ` <span style="color:#888;">(${escape(c.setCode)})</span>` : ''
        }</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">€${fmt(c.marketValue)}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; color:#f59e0b;">€${fmt(c.cashOffer)}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; color:#22c55e;">€${fmt(c.creditOffer)}</td>
      </tr>`,
    )
    .join('');
  const greeting = customerName ? `Hi ${escape(customerName)}, ` : 'Hi, ';
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif; max-width:640px; margin:0 auto; padding:24px; color:#222;">
    <h2 style="color:#1a1a1a; margin-bottom:4px;">Your ${escape(shopName)} Quote</h2>
    <p style="color:#666; margin-top:0;">${greeting}here's an indicative price for the cards you sent over. Final offer depends on condition verified in-store.</p>
    <table style="width:100%; border-collapse:collapse; margin:16px 0;">
      <thead><tr style="background:#f5f5f5;">
        <th style="padding:8px; text-align:left;">Card</th>
        <th style="padding:8px; text-align:right;">Market</th>
        <th style="padding:8px; text-align:right;">Cash offer</th>
        <th style="padding:8px; text-align:right;">Credit offer</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr style="font-weight:700; background:#fafafa;">
        <td style="padding:8px;">Totals (${cards.length} card${cards.length !== 1 ? 's' : ''})</td>
        <td style="padding:8px; text-align:right;">€${fmt(totals.market)}</td>
        <td style="padding:8px; text-align:right; color:#f59e0b;">€${fmt(totals.cash)}</td>
        <td style="padding:8px; text-align:right; color:#22c55e;">€${fmt(totals.credit)}</td>
      </tr></tfoot>
    </table>
    <p style="font-size:13px; color:#666;">Cash offer: ${cashPct}% of market value. Store credit: ${creditPct}% of market value. Condition-adjusted.</p>
    <p style="margin-top:24px;">Bring your cards to the shop or reply to this email to arrange drop-off. We'll give you a firm offer once we grade condition.</p>
    <p style="color:#888; font-size:12px; margin-top:32px;">${escape(shopName)}</p>
  </div>`;
}

/** Shop-internal "new lead" notification email. */
export function shopLeadHtml(
  args: QuoteEmailArgs & {
    leadEmail: string;
    leadName?: string | null;
    newsletter?: boolean;
    attachmentCount?: number;
  },
): string {
  const { cards, totals, leadEmail, leadName, newsletter, attachmentCount } = args;
  const rows = cards
    .map(
      (c, i) => `<tr>
        <td style="padding:8px; border-bottom:1px solid #eee; color:#666;">${String(i + 1).padStart(2, '0')}</td>
        <td style="padding:8px; border-bottom:1px solid #eee;">${escape(c.name || 'Unknown')}${
          c.setCode ? ` <span style="color:#888;">(${escape(c.setCode)})</span>` : ''
        }${c.cardNumber ? ` <span style="color:#888;">#${escape(c.cardNumber)}</span>` : ''}${
          c.conditionEstimate ? ` <span style="color:#888;">· ${escape(c.conditionEstimate)}</span>` : ''
        }</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">€${fmt(c.marketValue)}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; color:#b45309;">€${fmt(c.cashOffer)}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; color:#ca8a04;">€${fmt(c.creditOffer)}</td>
      </tr>`,
    )
    .join('');
  return `<div style="font-family:sans-serif;">
    <h3>New quote request</h3>
    <p><b>Email:</b> ${escape(leadEmail)}${leadName ? ' &middot; <b>Name:</b> ' + escape(leadName) : ''}${
      newsletter ? ' &middot; <b>Newsletter:</b> YES' : ''
    }</p>
    <p><b>Totals:</b> Market €${fmt(totals.market)} &middot; Cash €${fmt(totals.cash)} &middot; Credit €${fmt(totals.credit)}</p>
    ${attachmentCount ? `<p style="color:#666; font-size:13px;">${attachmentCount} card photo${attachmentCount !== 1 ? 's' : ''} attached.</p>` : ''}
    <table style="width:100%; border-collapse:collapse;">
      <thead><tr><th align="left">#</th><th align="left">Card</th><th align="right">MV</th><th align="right">Cash</th><th align="right">Credit</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}
