'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
function isPrivateAddress(ip) {
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe[89ab]|ff)/.test(lower);
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * Validates that a URL is http(s) and resolves only to public addresses (basic SSRF guard).
 * @returns {Promise<URL>}
 */
async function assertPublicHttpUrl(input) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    throw new Error('That is not a valid URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http:// and https:// links are allowed.');
  if (url.username || url.password) throw new Error('Links with embedded credentials are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('That address is not publicly reachable.');
  }
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new Error('I could not resolve that address.');
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error('That address is not publicly reachable.');
  return url;
}

/** fetch() with a hard timeout. Throws on network errors and non-2xx unless `allowError`. */
async function request(url, { timeoutMs = 10_000, allowError = false, ...init } = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok && !allowError) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

module.exports = { isPrivateAddress, assertPublicHttpUrl, request };
