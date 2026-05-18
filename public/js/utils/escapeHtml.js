/**
 * Shared HTML escaping utility to prevent XSS. Used by all modal
 * components.
 *
 * Escapes the full OWASP-recommended set (`& < > " '`) so the same
 * call is safe in BOTH text and attribute contexts. The previous
 * `textContent`/`innerHTML` trick only escaped `& < >`, which left
 * attribute-context callers (e.g. `value="${escapeHtml(x)}"`) open to
 * breakout; quote-escaping is display-equivalent in text context, so
 * hardening is behaviour-preserving there.
 */
function escapeHtml(text) {
  if (text == null || text === '') return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.escapeHtml = escapeHtml;
