// IP hashing for quote_leads.ip_hash. SHA-256 with a daily-rotating salt
// keeps the raw IP out of the database while still allowing
// "same IP submitted 50 leads" abuse detection within a 24h window.

import { createHash } from 'node:crypto';

export function hashIp(ip: string | null | undefined, salt: string): string | null {
  if (!ip) return null;
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  return createHash('sha256').update(`${ip}|${day}|${salt}`).digest('hex').slice(0, 32);
}
