// apps/server/routes/quote-lead.js
// Owner: A1 | Slice: S5
//
// POST /api/quote-lead — V1 server.js:5275-5545. Customer email gate;
// sends emails via Brevo, persists to quote_leads, optional newsletter
// subscribe (Brevo / Mailchimp / ConvertKit / off).
//
// V2_AUDIT §5.13 (R6 mitigation companion): the lead row is persisted
// regardless of Brevo send success — a Brevo outage cannot kill lead
// capture. The persistLead() helper is fire-and-forget below.

import express from 'express';
import crypto from 'crypto';
import { supabase } from '../_clients.js';
import { quoteLeadLimiter } from '../middleware/rate-limit.js';
import { SHOP_SLUG_RE, EMAIL_RE } from './shop.js';

const router = express.Router();

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Daily-rotating salted hash so the leads table can detect "same IP submitted
// 50 leads" without storing the raw IP.
function hashIp(ip) {
  if (!ip) return null;
  const day = new Date().toISOString().slice(0, 10);
  const salt = process.env.IP_HASH_SALT || 'card-pricer-default-salt';
  return crypto.createHash('sha256').update(`${ip}|${day}|${salt}`).digest('hex').slice(0, 32);
}

router.post('/api/quote-lead', quoteLeadLimiter, async (req, res) => {
  try {
    const { email, name, newsletter, cards, totals, cashPct, creditPct, shop_slug } = req.body || {};
    if (!email || !cards || !Array.isArray(cards) || !cards.length) {
      return res.status(400).json({ error: 'email and cards required' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'invalid email' });
    }
    const trimmed = cards.slice(0, 20);

    let shop = null;
    if (shop_slug && supabase) {
      const slugLc = String(shop_slug).toLowerCase();
      if (SHOP_SLUG_RE.test(slugLc)) {
        try {
          const { data } = await supabase.from('shops').select('*').eq('slug', slugLc).eq('active', true).maybeSingle();
          if (data) shop = data;
        } catch (e) {
          console.warn('[QUOTE-LEAD] shop lookup failed:', e.message);
        }
      }
    }

    const SHOP_EMAIL = shop?.email || process.env.SHOP_EMAIL || 'dave@boardandbrewed.ie';
    const SHOP_NAME = shop?.name || process.env.SHOP_NAME || 'Board & Brewed';
    const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || SHOP_EMAIL;

    const rowsPlain = trimmed.map(c => {
      const cash = (c.cash_offer ?? 0).toFixed(2);
      const credit = (c.credit_offer ?? 0).toFixed(2);
      const mv = (c.market_value ?? 0).toFixed(2);
      return `<tr>
        <td style="padding:8px; border-bottom:1px solid #eee;">${escapeHtml(c.name || 'Unknown')}${c.set_code ? ' <span style="color:#888;">(' + escapeHtml(c.set_code) + ')</span>' : ''}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">€${mv}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; color:#f59e0b;">€${cash}</td>
        <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; color:#22c55e;">€${credit}</td>
      </tr>`;
    }).join('');
    const rows = rowsPlain;

    const attachments = [];
    let totalBytes = 0;
    trimmed.forEach((c, i) => {
      if (!c.photo || typeof c.photo !== 'string' || !c.photo.startsWith('data:image/')) return;
      const commaIdx = c.photo.indexOf(',');
      if (commaIdx < 0) return;
      const b64 = c.photo.slice(commaIdx + 1);
      const estBytes = Math.floor(b64.length * 0.75);
      if (totalBytes + estBytes > 9 * 1024 * 1024) return;
      totalBytes += estBytes;
      const safeName = (c.name || 'card').replace(/[^a-z0-9_\-]+/gi, '_').slice(0, 30);
      attachments.push({
        name: `${String(i + 1).padStart(2, '0')}-${safeName}.jpg`,
        content: b64
      });
    });

    const customerHtml = `
      <div style="font-family:-apple-system,system-ui,sans-serif; max-width:640px; margin:0 auto; padding:24px; color:#222;">
        <h2 style="color:#1a1a1a; margin-bottom:4px;">Your ${SHOP_NAME} Quote</h2>
        <p style="color:#666; margin-top:0;">Hi${name ? ' ' + escapeHtml(name) : ''}, here's an indicative price for the cards you sent over. Final offer depends on condition verified in-store.</p>
        <table style="width:100%; border-collapse:collapse; margin:16px 0;">
          <thead><tr style="background:#f5f5f5;">
            <th style="padding:8px; text-align:left;">Card</th>
            <th style="padding:8px; text-align:right;">Market</th>
            <th style="padding:8px; text-align:right;">Cash offer</th>
            <th style="padding:8px; text-align:right;">Credit offer</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr style="font-weight:700; background:#fafafa;">
            <td style="padding:8px;">Totals (${trimmed.length} card${trimmed.length !== 1 ? 's' : ''})</td>
            <td style="padding:8px; text-align:right;">€${(totals?.market || 0).toFixed(2)}</td>
            <td style="padding:8px; text-align:right; color:#f59e0b;">€${(totals?.cash || 0).toFixed(2)}</td>
            <td style="padding:8px; text-align:right; color:#22c55e;">€${(totals?.credit || 0).toFixed(2)}</td>
          </tr></tfoot>
        </table>
        <p style="font-size:13px; color:#666;">Cash offer: ${cashPct || 55}% of market value. Store credit: ${creditPct || 70}% of market value. Condition-adjusted.</p>
        <p style="margin-top:24px;">Bring your cards to the shop or reply to this email to arrange drop-off. We'll give you a firm offer once we grade condition.</p>
        <p style="color:#888; font-size:12px; margin-top:32px;">${SHOP_NAME}</p>
      </div>`;

    const shopHtml = `
      <div style="font-family:sans-serif;">
        <h3>New quote request</h3>
        <p><b>Email:</b> ${escapeHtml(email)}${name ? ' &middot; <b>Name:</b> ' + escapeHtml(name) : ''}${newsletter ? ' &middot; <b>Newsletter:</b> YES' : ''}</p>
        <p><b>Totals:</b> Market €${(totals?.market || 0).toFixed(2)} &middot; Cash €${(totals?.cash || 0).toFixed(2)} &middot; Credit €${(totals?.credit || 0).toFixed(2)}</p>
        <p style="color:#666; font-size:13px;">${attachments.length} card photo${attachments.length !== 1 ? 's' : ''} attached.</p>
        <table style="width:100%; border-collapse:collapse;">
          <thead><tr><th align="left">#</th><th align="left">Card</th><th align="right">MV</th><th align="right">Cash</th><th align="right">Credit</th></tr></thead>
          <tbody>${trimmed.map((c, i) => {
            const cash = (c.cash_offer ?? 0).toFixed(2);
            const credit = (c.credit_offer ?? 0).toFixed(2);
            const mv = (c.market_value ?? 0).toFixed(2);
            return `<tr>
              <td style="padding:8px; border-bottom:1px solid #eee; color:#666;">${String(i+1).padStart(2,'0')}</td>
              <td style="padding:8px; border-bottom:1px solid #eee;">${escapeHtml(c.name || 'Unknown')}${c.set_code ? ' <span style="color:#888;">(' + escapeHtml(c.set_code) + ')</span>' : ''}${c.card_number ? ' <span style="color:#888;">#' + escapeHtml(c.card_number) + '</span>' : ''}${c.condition_estimate ? ' <span style="color:#888;">· ' + escapeHtml(c.condition_estimate) + '</span>' : ''}</td>
              <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">€${mv}</td>
              <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; color:#b45309;">€${cash}</td>
              <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; color:#ca8a04;">€${credit}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;

    const persistLead = (extra) => {
      if (!supabase) return;
      supabase.from('quote_leads').insert({
        shop_id: shop?.id || null,
        shop_slug: shop?.slug || null,
        email,
        name: name || null,
        newsletter: !!newsletter,
        card_count: trimmed.length,
        total_market: totals?.market || 0,
        total_cash: totals?.cash || 0,
        total_credit: totals?.credit || 0,
        cards_json: trimmed.map(c => ({
          name: c.name, set_code: c.set_code, card_number: c.card_number,
          mv: c.market_value, cash: c.cash_offer, credit: c.credit_offer,
          condition: c.condition_estimate || null
        })),
        ip_hash: hashIp(req.ip),
        ...extra
      }).then(() => {}, e => console.warn('[QUOTE-LEAD] insert failed:', e.message));
    };

    if (!process.env.BREVO_API_KEY) {
      console.log('[QUOTE-LEAD] (no BREVO_API_KEY set) would email to', email, 'and', SHOP_EMAIL);
      console.log('[QUOTE-LEAD] payload:', { email, name, newsletter, cardCount: trimmed.length, totals });
      persistLead();
      return res.json({ ok: true, emailed: false, note: 'Logged server-side. Set BREVO_API_KEY to enable email.' });
    }

    const sendOne = (toEmail, subject, htmlContent, attachmentsList) => {
      const payload = {
        sender: { name: SHOP_NAME, email: SENDER_EMAIL },
        to: [{ email: toEmail }],
        subject,
        htmlContent
      };
      if (attachmentsList && attachmentsList.length) payload.attachment = attachmentsList;
      return fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      }).then(r => r.ok ? r.json() : r.text().then(t => { throw new Error('Brevo ' + r.status + ': ' + t); }));
    };

    const provider = shop?.newsletter_provider || 'brevo';

    async function subscribeBrevo() {
      const listId = shop?.brevo_list_id || parseInt(process.env.BREVO_NEWSLETTER_LIST_ID || '0', 10);
      if (!listId) return { subscribed: false, reason: 'no brevo list configured' };
      if (!process.env.BREVO_API_KEY) return { subscribed: false, reason: 'no brevo api key' };
      try {
        const r = await fetch('https://api.brevo.com/v3/contacts', {
          method: 'POST',
          headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ email, attributes: name ? { FIRSTNAME: name } : {}, listIds: [listId], updateEnabled: true })
        });
        if (!r.ok) {
          const text = await r.text();
          console.warn('[QUOTE-LEAD] brevo subscribe failed:', r.status, text);
          return { subscribed: false, reason: text };
        }
        return { subscribed: true, provider: 'brevo' };
      } catch (e) {
        return { subscribed: false, reason: e.message };
      }
    }

    async function subscribeMailchimp() {
      const apiKey = shop?.mailchimp_api_key;
      const listId = shop?.mailchimp_list_id;
      if (!apiKey || !listId) return { subscribed: false, reason: 'mailchimp not configured' };
      const dc = String(apiKey).split('-').pop();
      if (!dc) return { subscribed: false, reason: 'mailchimp api key has no DC suffix' };
      try {
        const r = await fetch(`https://${dc}.api.mailchimp.com/3.0/lists/${encodeURIComponent(listId)}/members`, {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + Buffer.from('anystring:' + apiKey).toString('base64'),
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email_address: email,
            status: 'subscribed',
            merge_fields: name ? { FNAME: name } : {}
          })
        });
        if (!r.ok) {
          const text = await r.text();
          if (text.includes('Member Exists')) return { subscribed: true, provider: 'mailchimp', existed: true };
          console.warn('[QUOTE-LEAD] mailchimp subscribe failed:', r.status, text);
          return { subscribed: false, reason: text };
        }
        return { subscribed: true, provider: 'mailchimp' };
      } catch (e) {
        return { subscribed: false, reason: e.message };
      }
    }

    async function subscribeConvertKit() {
      const apiKey = shop?.convertkit_api_key;
      const formId = shop?.convertkit_form_id;
      if (!apiKey || !formId) return { subscribed: false, reason: 'convertkit not configured' };
      try {
        const r = await fetch(`https://api.convertkit.com/v3/forms/${encodeURIComponent(formId)}/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: apiKey, email, first_name: name || undefined })
        });
        if (!r.ok) {
          const text = await r.text();
          console.warn('[QUOTE-LEAD] convertkit subscribe failed:', r.status, text);
          return { subscribed: false, reason: text };
        }
        return { subscribed: true, provider: 'convertkit' };
      } catch (e) {
        return { subscribed: false, reason: e.message };
      }
    }

    const subscribeIfOptedIn = async () => {
      if (!newsletter) return { subscribed: false };
      if (provider === 'off') return { subscribed: false, reason: 'provider off — opt-in saved to quote_leads' };
      if (provider === 'mailchimp') return subscribeMailchimp();
      if (provider === 'convertkit') return subscribeConvertKit();
      return subscribeBrevo();
    };

    const [,, subRes] = await Promise.all([
      sendOne(email, `Your ${SHOP_NAME} card quote`, customerHtml),
      sendOne(SHOP_EMAIL, `New quote request — ${email}${newsletter ? ' (newsletter opt-in)' : ''}`, shopHtml, attachments),
      subscribeIfOptedIn()
    ]);

    persistLead();
    res.json({ ok: true, emailed: true, subscribed: subRes.subscribed });
  } catch (e) {
    console.error('[QUOTE-LEAD] failed:', e);
    res.status(500).json({ error: e.message || 'Failed to send quote' });
  }
});

export default router;
