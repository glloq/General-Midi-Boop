/**
 * Shared HTML escaping utility (XSS prevention). Escapes the full
 * OWASP-recommended set (`& < > " '`) so the same call is safe in BOTH
 * text and attribute contexts.
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
