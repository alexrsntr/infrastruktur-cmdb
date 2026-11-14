import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { clientIp } from './audit';

/**
 * Key of all rate limits: the client address as Express resolved it (see TRUST_PROXY in config.ts), without the
 * port that Azure App Service appends ("203.0.113.7:51234" – with the port every connection would get its own
 * counter) and with IPv6 addresses grouped by subnet.
 */
export function clientKey(req: Request): string {
  return ipKeyGenerator(clientIp(req) ?? 'unknown');
}
