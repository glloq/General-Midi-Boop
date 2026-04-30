/**
 * @file src/api/middleware/captivePortal.js
 * @description Captive-portal middleware. When the hotspot is active,
 * intercepts requests issued by the captive-portal probes that mobile
 * OSes run as soon as they associate with a WiFi network, and answers
 * them with a 302 redirect to the local web app. Receiving a redirect
 * (instead of the expected 204 / "Success" payload) is the cue the OS
 * uses to spawn its "Sign in to network" browser overlay — the user
 * lands on GMBoop without typing the gateway IP.
 *
 * No-op when the hotspot is off, so this middleware is safe to install
 * unconditionally.
 *
 * Companion DNS hijack lives in `scripts/captive-portal-dnsmasq.conf`
 * (deployed to /etc/NetworkManager/dnsmasq-shared.d/ by Install.sh):
 * without it, devices won't even reach this Express app because their
 * DNS query for `captive.apple.com` etc. would fail.
 */

/**
 * Well-known probe paths used by the major OSes / browsers. We match
 * on path because the `Host:` header check below already covers most
 * cases; the explicit list catches probes whose hostname happens to
 * resolve to us legitimately (e.g. the user is connected via Ethernet
 * and a captive proxy is in front).
 */
const PROBE_PATHS = new Set([
  '/hotspot-detect.html',                  // Apple iOS / macOS
  '/library/test/success.html',            // Apple legacy
  '/generate_204',                         // Android / Chrome OS
  '/gen_204',                              // Android legacy
  '/connecttest.txt',                      // Windows 10/11
  '/ncsi.txt',                             // Windows NCSI
  '/redirect',                             // Windows captive
  '/canonical.html',                       // Firefox
  '/success.txt',                          // Firefox / various
  '/check_network_status.txt'              // Various
]);

/**
 * @param {string} host  Lower-cased Host header value (port stripped).
 * @returns {boolean} True if the hostname looks like a numeric IP — a
 *   proxy for "the client typed our gateway IP directly", which we let
 *   through. Captive-portal probes always carry a real domain name.
 */
function _isNumericIp(host) {
  if (!host) return false;
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':');
}

/**
 * Build the absolute redirect target. We prefer the local socket
 * address (the IP the client actually hit) so we don't have to hardcode
 * the NetworkManager-shared default of 10.42.0.1.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
function _redirectTarget(req) {
  let ip = req.socket?.localAddress || '10.42.0.1';
  // Strip the IPv6-mapped-IPv4 prefix node uses on dual-stack sockets.
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return `http://${ip}/`;
}

/**
 * @param {{hotspotManager:?{isActive:Function}, logger:?Object}} deps
 * @returns {import('express').RequestHandler}
 */
export function createCaptivePortalMiddleware({ hotspotManager, logger } = {}) {
  return function captivePortalMiddleware(req, res, next) {
    if (!hotspotManager || typeof hotspotManager.isActive !== 'function') return next();
    if (!hotspotManager.isActive()) return next();

    const rawHost = String(req.headers.host || '').split(':')[0].toLowerCase();
    const isOurs = !rawHost
      || rawHost === 'localhost'
      || rawHost === '127.0.0.1'
      || _isNumericIp(rawHost);

    // Probe path → always treat as captive probe, even when it resolves
    // to us (some OSes hard-code the IP). Non-IP host (i.e. DNS hijack
    // got triggered) → also a captive probe.
    if (!PROBE_PATHS.has(req.path) && isOurs) return next();

    // Some probes are HEAD requests; respond exactly the same way.
    const target = _redirectTarget(req);
    logger?.debug?.(`Captive portal redirect: host="${rawHost}" path="${req.path}" -> ${target}`);
    res.statusCode = 302;
    res.setHeader('Location', target);
    res.setHeader('Cache-Control', 'no-store');
    // Tiny body so older Windows clients that read the response (instead
    // of just the status code) don't trip on an empty payload.
    res.end(`<html><body><a href="${target}">Sign in</a></body></html>`);
  };
}

export default createCaptivePortalMiddleware;
