/**
 * SoundBankLoadingIndicator
 *
 * Petit popup non intrusif affiché en haut de la page pendant le
 * chargement d'une banque de son WebAudioFont (CDN surikov.github.io).
 *
 * Utilisation :
 *   SoundBankLoadingIndicator.begin();
 *   try { await synth.loadInstrument(program); }
 *   finally { SoundBankLoadingIndicator.end(); }
 *
 * - Compteur de références : reste visible tant que des chargements
 *   concurrents sont en cours.
 * - Délai d'apparition 150 ms : ne flashe pas si le chargement est
 *   instantané (sample déjà en cache navigateur).
 */
class SoundBankLoadingIndicator {
    static _count = 0;
    static _el = null;
    static _showTimer = null;
    static _hideTimer = null;

    static begin() {
        SoundBankLoadingIndicator._count++;
        if (SoundBankLoadingIndicator._hideTimer) {
            clearTimeout(SoundBankLoadingIndicator._hideTimer);
            SoundBankLoadingIndicator._hideTimer = null;
        }
        if (SoundBankLoadingIndicator._count === 1 &&
            !SoundBankLoadingIndicator._showTimer &&
            !SoundBankLoadingIndicator._el) {
            SoundBankLoadingIndicator._showTimer = setTimeout(() => {
                SoundBankLoadingIndicator._showTimer = null;
                if (SoundBankLoadingIndicator._count > 0) {
                    SoundBankLoadingIndicator._render();
                }
            }, 150);
        }
    }

    static end() {
        SoundBankLoadingIndicator._count = Math.max(0, SoundBankLoadingIndicator._count - 1);
        if (SoundBankLoadingIndicator._count === 0) {
            if (SoundBankLoadingIndicator._showTimer) {
                clearTimeout(SoundBankLoadingIndicator._showTimer);
                SoundBankLoadingIndicator._showTimer = null;
            }
            const el = SoundBankLoadingIndicator._el;
            if (el) {
                el.classList.remove('sound-loading-toast--visible');
                SoundBankLoadingIndicator._el = null;
                SoundBankLoadingIndicator._hideTimer = setTimeout(() => {
                    SoundBankLoadingIndicator._hideTimer = null;
                    if (el.parentNode) el.parentNode.removeChild(el);
                }, 250);
            }
        }
    }

    static _render() {
        let label = 'Chargement de la banque de son…';
        try {
            if (window.i18n && typeof window.i18n.t === 'function') {
                const translated = window.i18n.t('midiEditor.loadingSoundBank');
                if (translated && translated !== 'midiEditor.loadingSoundBank') {
                    label = translated;
                }
            }
        } catch (_) { /* fallback */ }

        const el = document.createElement('div');
        el.className = 'sound-loading-toast';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');

        const spinner = document.createElement('span');
        spinner.className = 'sound-loading-toast__spinner';
        const text = document.createElement('span');
        text.className = 'sound-loading-toast__label';
        text.textContent = label;

        el.appendChild(spinner);
        el.appendChild(text);
        document.body.appendChild(el);

        requestAnimationFrame(() => {
            el.classList.add('sound-loading-toast--visible');
        });

        SoundBankLoadingIndicator._el = el;
    }
}

if (typeof window !== 'undefined') {
    window.SoundBankLoadingIndicator = SoundBankLoadingIndicator;
}
