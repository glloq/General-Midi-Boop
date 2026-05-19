// Dead legacy module. The settings modal content (renderContent /
// getLocaleFlag / updateModalTexts) is provided by SettingsTemplates.js,
// which is the only one Object.assign'd onto SettingsModal.prototype (see
// SettingsModal.js). This earlier single-column layout was superseded by
// the two-column SettingsTemplates layout and is no longer mixed in or
// referenced anywhere. The global is kept (empty) so the <script> tag in
// index.html still resolves and any defensive `typeof` check stays valid.
(function () {
  'use strict';
  if (typeof window !== 'undefined') window.SettingsModalContent = {};
})();
