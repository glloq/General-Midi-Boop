(function() {
    'use strict';

    const StartupUpdateNotif = {};

    let _ran = false;

    function _dismiss(banner) {
        if (!banner || !banner.parentNode) return;
        clearTimeout(banner._dismissTimer);
        banner.style.opacity = '0';
        banner.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
        banner.style.transform = 'translateX(-50%) translateY(-10px)';
        setTimeout(() => banner.remove(), 400);
    }

    function _showBanner(text, bgGradient, actionLabel, onAction, autoDismissMs) {
        const existing = document.getElementById('startupUpdateBanner');
        if (existing) existing.remove();

        const banner = document.createElement('div');
        banner.id = 'startupUpdateBanner';
        banner.style.cssText = [
            'position:fixed', 'top:20px', 'left:50%', 'transform:translateX(-50%)',
            'z-index:100000', `background:${bgGradient}`, 'color:white',
            'padding:12px 14px 12px 20px', 'border-radius:10px',
            'font-size:14px', 'font-weight:600',
            'box-shadow:0 4px 24px rgba(0,0,0,0.3)',
            'display:flex', 'align-items:center', 'gap:12px',
            'animation:fadeInDown 0.3s ease', 'max-width:90vw',
        ].join(';');

        const textSpan = document.createElement('span');
        textSpan.style.flex = '1';
        textSpan.textContent = text;
        banner.appendChild(textSpan);

        if (actionLabel && onAction) {
            const actionBtn = document.createElement('button');
            actionBtn.textContent = actionLabel;
            actionBtn.style.cssText = [
                'padding:5px 12px', 'border:1.5px solid rgba(255,255,255,0.7)',
                'border-radius:6px', 'background:rgba(255,255,255,0.2)', 'color:white',
                'cursor:pointer', 'font-size:12px', 'font-weight:600', 'white-space:nowrap',
            ].join(';');
            actionBtn.addEventListener('click', () => { _dismiss(banner); onAction(); });
            banner.appendChild(actionBtn);
        }

        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '&times;';
        closeBtn.title = 'Fermer';
        closeBtn.style.cssText = [
            'background:none', 'border:none', 'color:rgba(255,255,255,0.8)',
            'cursor:pointer', 'font-size:20px', 'font-weight:700',
            'padding:0 4px', 'line-height:1', 'flex-shrink:0',
        ].join(';');
        closeBtn.addEventListener('click', () => _dismiss(banner));
        banner.appendChild(closeBtn);

        document.body.appendChild(banner);
        banner._dismissTimer = setTimeout(() => _dismiss(banner), autoDismissMs);
    }

    /**
     * Run once per page load. Reads settings, queries backend, shows banner if needed.
     * @param {object} api  — window.api / window.apiClient
     */
    StartupUpdateNotif.run = async function(api) {
        if (_ran) return;
        _ran = true;

        try {
            const saved = localStorage.getItem('gmboop_settings');
            const settings = saved ? JSON.parse(saved) : {};

            if (settings.startupUpdateCheck === false) return;

            const showBeta = settings.startupBetaNotif === true;

            if (!api || !api.sendCommand) return;

            const result = await api.sendCommand('system_check_update', {}, 20000);
            if (!result || result.error) return;

            const stable = result.stable || {};
            const beta = result.beta ||
                (!stable.upToDate && !stable.majorMinorChanged
                    ? { upToDate: false, behindCount: stable.behindCount, remoteHash: stable.remoteHash }
                    : null);

            const openSettings = () => {
                if (window.settingsModal) window.settingsModal.open();
            };

            if (stable.majorMinorChanged) {
                _showBanner(
                    `🆕 Nouvelle version v${stable.remoteVersion} disponible !`,
                    'linear-gradient(135deg, #16a34a, #15803d)',
                    '⚙️ Voir',
                    openSettings,
                    8000
                );
            } else if (showBeta && beta && !beta.upToDate) {
                const n = beta.behindCount || 0;
                _showBanner(
                    `🔶 ${n} commit${n > 1 ? 's' : ''} bêta disponible${n > 1 ? 's' : ''} — ${beta.remoteHash || ''}`,
                    'linear-gradient(135deg, #d97706, #b45309)',
                    '⚙️ Voir',
                    openSettings,
                    5000
                );
            }
        } catch (_e) { /* silent — startup check must never crash the app */ }
    };

    if (typeof window !== 'undefined') window.StartupUpdateNotif = StartupUpdateNotif;
})();
