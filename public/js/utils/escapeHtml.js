/**
 * Shared HTML escaping utility to prevent XSS.
 * Used by all modal components.
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

window.escapeHtml = escapeHtml;
