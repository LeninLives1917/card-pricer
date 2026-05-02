// Email + newsletter adapters. Plain TS functions so they're trivially
// unit-testable; no Node-only deps. Server passes its env in as args
// rather than reading process.env directly (keeps the package portable).

export type NewsletterProvider = 'brevo' | 'mailchimp' | 'convertkit' | 'off';

export interface BrevoConfig {
  apiKey: string;
  senderEmail: string;
  senderName: string;
}

export interface BrevoSendArgs {
  to: string;
  subject: string;
  htmlContent: string;
  attachments?: Array<{ name: string; content: string }>;
}

/**
 * Send a transactional email via Brevo. Returns parsed JSON on success
 * or throws on non-2xx. Used for both customer-facing quote emails and
 * shop-side lead notifications.
 */
export async function brevoSendEmail(
  config: BrevoConfig,
  args: BrevoSendArgs,
): Promise<{ messageId?: string }> {
  const payload: Record<string, unknown> = {
    sender: { name: config.senderName, email: config.senderEmail },
    to: [{ email: args.to }],
    subject: args.subject,
    htmlContent: args.htmlContent,
  };
  if (args.attachments && args.attachments.length > 0) {
    payload.attachment = args.attachments;
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': config.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Brevo ${res.status}: ${text}`);
  }
  return (await res.json()) as { messageId?: string };
}

export interface SubscribeArgs {
  email: string;
  name?: string | null;
}

export interface SubscribeResult {
  subscribed: boolean;
  provider?: NewsletterProvider;
  reason?: string;
  existed?: boolean;
}

/**
 * Subscribe an email to a Brevo list. Idempotent — list memberships are
 * deduped by Brevo. updateEnabled:true upserts existing contacts.
 */
export async function subscribeBrevo(
  args: SubscribeArgs,
  apiKey: string,
  listId: number,
): Promise<SubscribeResult> {
  if (!apiKey) return { subscribed: false, reason: 'no brevo api key' };
  if (!listId) return { subscribed: false, reason: 'no brevo list configured' };
  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      email: args.email,
      attributes: args.name ? { FIRSTNAME: args.name } : {},
      listIds: [listId],
      updateEnabled: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { subscribed: false, reason: text };
  }
  return { subscribed: true, provider: 'brevo' };
}

/**
 * Subscribe to a Mailchimp audience. DC is derived from the API key's
 * suffix (`abc123-us21` → `us21`) — that's how the Mailchimp API works.
 */
export async function subscribeMailchimp(
  args: SubscribeArgs,
  apiKey: string,
  listId: string,
): Promise<SubscribeResult> {
  if (!apiKey || !listId) return { subscribed: false, reason: 'mailchimp not configured' };
  const dc = apiKey.split('-').pop();
  if (!dc) return { subscribed: false, reason: 'mailchimp api key missing -dc suffix' };
  const url = `https://${dc}.api.mailchimp.com/3.0/lists/${encodeURIComponent(listId)}/members`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`anystring:${apiKey}`)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email_address: args.email,
      status: 'subscribed',
      merge_fields: args.name ? { FNAME: args.name } : {},
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (text.includes('Member Exists')) {
      return { subscribed: true, provider: 'mailchimp', existed: true };
    }
    return { subscribed: false, reason: text };
  }
  return { subscribed: true, provider: 'mailchimp' };
}

/** Subscribe to a ConvertKit form. */
export async function subscribeConvertKit(
  args: SubscribeArgs,
  apiKey: string,
  formId: string,
): Promise<SubscribeResult> {
  if (!apiKey || !formId) return { subscribed: false, reason: 'convertkit not configured' };
  const res = await fetch(
    `https://api.convertkit.com/v3/forms/${encodeURIComponent(formId)}/subscribe`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        email: args.email,
        first_name: args.name ?? undefined,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { subscribed: false, reason: text };
  }
  return { subscribed: true, provider: 'convertkit' };
}
