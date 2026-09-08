/**
 * @file src/api/securityPolicy.js
 * @description Single source of truth for the API security mode and for the
 * network-layer trust predicates shared by the HTTP and WebSocket layers.
 *
 * Why this module exists: `securityMode` used to be read in `HttpServer.js`
 * and nowhere else, so `GMBOOP_SECURITY_MODE=secure` hardened only HTTP while
 * the WebSocket — which carries the whole command surface, `system_update` and
 * `system_shutdown` included — kept accepting unauthenticated clients that
 * forged `Origin` and `Host`. The documented countermeasure was therefore
 * false, which is worse than no countermeasure (audit L10 F-108). Keeping the
 * resolution in one module makes that drift impossible to reintroduce.
 *
 * Modes:
 *   - `trusted-lan` (default) — convenience bypasses for the same-origin SPA
 *     and for clients whose *source address* is on a private network. Means,
 *     literally: any client that can reach the port from the LAN has full
 *     access, token or not.
 *   - `secure` — the bearer token is required for EVERY authenticated entry
 *     point, HTTP and WebSocket alike. No same-origin, loopback or private-
 *     network exception.
 */

/** Default mode when neither the env var nor `config.security.mode` is set. */
export const DEFAULT_SECURITY_MODE = 'trusted-lan';

/**
 * Resolve the effective security mode. `GMBOOP_SECURITY_MODE` wins over
 * `config.security.mode`, which wins over {@link DEFAULT_SECURITY_MODE}.
 * Any value other than `secure` (case-insensitive) resolves to
 * `trusted-lan` — an unreadable value must never silently *loosen* nor
 * silently *tighten* the box; it stays on the documented default.
 *
 * @param {?Object} config - Parsed application config (may be null).
 * @returns {'secure'|'trusted-lan'}
 */
export function resolveSecurityMode(config) {
  const raw = String(
    process.env.GMBOOP_SECURITY_MODE || config?.security?.mode || DEFAULT_SECURITY_MODE
  ).toLowerCase();
  return raw === 'secure' ? 'secure' : 'trusted-lan';
}

/**
 * @param {?Object} config
 * @returns {boolean} True when the effective mode is `secure`.
 */
export function isSecureMode(config) {
  return resolveSecurityMode(config) === 'secure';
}

/**
 * Normalise a socket address: strips the IPv6-mapped-IPv4 prefix
 * (`::ffff:192.168.1.10` → `192.168.1.10`) and the IPv6 zone index
 * (`fe80::1%eth0` → `fe80::1`).
 *
 * @param {*} ip
 * @returns {string} Normalised address, or `''` when the input is unusable.
 */
export function normalizeAddress(ip) {
  if (typeof ip !== 'string' || ip.length === 0) return '';
  let out = ip;
  if (out.startsWith('::ffff:')) out = out.slice(7);
  const zone = out.indexOf('%');
  if (zone !== -1) out = out.slice(0, zone);
  return out;
}

/**
 * True when the address is a loopback address. Unlike an `Origin` or `Host`
 * header, the peer address of an accepted TCP connection cannot be forged by
 * the client — that is the whole point of anchoring the loopback bypass on it
 * (audit L10 F-108).
 *
 * @param {*} ip - Raw `socket.remoteAddress` (or `req.ip`).
 * @returns {boolean}
 */
export function isLoopbackAddress(ip) {
  const addr = normalizeAddress(ip);
  if (!addr) return false;
  return addr === '::1' || addr === '127.0.0.1' || addr.startsWith('127.');
}

/**
 * True when the address belongs to a private network: RFC 1918, CGNAT-free
 * link-local 169.254/16, loopback, IPv6 ULA (fc00::/7) or IPv6 link-local
 * (fe80::/10).
 *
 * NOTE (audit L10 F-114): this is a *source address* test, so it survives
 * header forgery — but it is defeated by any local reverse proxy or tunnel
 * (`cloudflared`, `ngrok`, nginx on the same host), which makes every request
 * arrive from 127.0.0.1. `trust proxy` is deliberately not configured, so
 * `X-Forwarded-For` is never honoured. Behind such a front end the only
 * correct configuration is `security.mode=secure`.
 *
 * @param {*} ip
 * @returns {boolean}
 */
export function isPrivateAddress(ip) {
  const addr = normalizeAddress(ip);
  if (!addr) return false;
  if (isLoopbackAddress(addr)) return true;
  if (addr.startsWith('10.') || addr.startsWith('192.168.')) return true;
  if (addr.startsWith('169.254.')) return true; // link-local
  if (addr.startsWith('172.')) {
    const second = Number(addr.split('.')[1]);
    if (second >= 16 && second <= 31) return true; // 172.16/12
  }
  // IPv6 ULA: fc00::/7 — first byte is 0xfc or 0xfd
  if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return true;
  // IPv6 link-local: fe80::/10
  if (/^fe[89ab][0-9a-f]:/i.test(addr)) return true;
  return false;
}
