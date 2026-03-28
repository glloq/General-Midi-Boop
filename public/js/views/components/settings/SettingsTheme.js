(function() {
    'use strict';
    const SettingsTheme = {};

    /**
     * Add CSS styles for the toggle switch
     */
    SettingsTheme.addToggleStyles = function() {
        const style = document.createElement('style');
        style.textContent = `
            .toggle-switch input:checked + .toggle-slider {
                background-color: #667eea !important;
            }

            .toggle-slider:before {
                position: absolute;
                content: "";
                height: 22px;
                width: 22px;
                left: 4px;
                bottom: 4px;
                background-color: white;
                transition: 0.4s;
                border-radius: 50%;
            }

            .toggle-switch input:checked + .toggle-slider:before {
                transform: translateX(30px);
            }

            .language-select:hover,
            .language-select:focus {
                border-color: #667eea !important;
                outline: none;
                box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
            }

            .settings-close-btn:hover {
                background: #f3f4f6 !important;
                color: #667eea !important;
            }

            .btn-secondary:hover {
                background: #f3f4f6 !important;
            }

            .btn-primary:hover {
                background: #5568d3 !important;
                box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
            }
        `;
        document.head.appendChild(style);
    };

    /**
     * Select a theme (update toggle state in modal)
     */
    SettingsTheme.selectTheme = function(theme) {
        const darkModeToggle = this.modal.querySelector('#darkModeToggle');
        if (darkModeToggle) {
            darkModeToggle.checked = theme === 'dark';
        }
    };

    /**
     * Apply a theme to the document
     */
    SettingsTheme.applyTheme = function(theme) {
        const root = document.documentElement;

        // Remove previous theme classes
        document.body.classList.remove('theme-dark', 'theme-colored', 'dark-mode');

        // Clean all inline custom properties to avoid leaking between themes
        const propsToClean = [
            '--bg-primary', '--bg-secondary', '--bg-tertiary',
            '--text-primary', '--text-secondary', '--text-muted', '--text-disabled',
            '--border-color', '--border-light',
            '--accent-primary', '--accent-secondary',
            '--success-color', '--warning-color', '--danger-color', '--info-color',
            '--card-bg', '--header-bg',
            '--shadow-light', '--shadow-medium', '--shadow-heavy',
            '--shadow-sm', '--shadow-md', '--shadow-lg',
            '--primary-color', '--primary-hover', '--primary-active',
            '--secondary-color', '--accent-warning', '--accent-danger', '--accent-success',
            '--color-primary', '--color-secondary', '--color-accent',
            '--instrument-primary', '--instrument-success', '--instrument-warning',
            '--instrument-error', '--instrument-usb', '--instrument-wifi',
            '--instrument-bluetooth', '--instrument-bg', '--instrument-border', '--instrument-shadow',
            '--bluetooth-primary', '--bluetooth-success', '--bluetooth-danger',
            '--bluetooth-border', '--bluetooth-shadow',
            '--network-primary', '--network-secondary', '--network-success',
            '--network-danger', '--network-border', '--network-shadow',
            '--focus-ring',
            '--scrollbar-track-bg', '--scrollbar-thumb-bg', '--scrollbar-thumb-hover',
            '--scrollbar-thumb-active', '--scrollbar-thumb-border', '--scrollbar-corner-bg'
        ];
        propsToClean.forEach(p => root.style.removeProperty(p));

        if (theme === 'dark') {
            // Dark mode
            document.body.classList.add('theme-dark', 'dark-mode');
            root.style.setProperty('--bg-primary', '#1a1a1a');
            root.style.setProperty('--bg-secondary', '#2d2d2d');
            root.style.setProperty('--text-primary', '#ffffff');
            root.style.setProperty('--text-secondary', '#cccccc');
            root.style.setProperty('--border-color', '#404040');
            root.style.setProperty('--card-bg', '#2d2d2d');
            root.style.setProperty('--header-bg', '#2d2d2d');
        } else {
            // Colored mode (default)
            document.body.classList.add('theme-colored');
            root.style.setProperty('--bg-primary', '#f0f4ff');
            root.style.setProperty('--bg-secondary', '#ffffff');
            root.style.setProperty('--bg-tertiary', '#e8eeff');
            root.style.setProperty('--text-primary', '#2d3561');
            root.style.setProperty('--text-secondary', '#5a6089');
            root.style.setProperty('--border-color', '#d4daff');
            root.style.setProperty('--card-bg', '#ffffff');
            root.style.setProperty('--header-bg', 'rgba(255, 255, 255, 0.92)');
            root.style.setProperty('--accent-primary', '#667eea');
            root.style.setProperty('--accent-secondary', '#764ba2');
            root.style.setProperty('--success-color', '#06d6a0');
            root.style.setProperty('--warning-color', '#ffd166');
            root.style.setProperty('--danger-color', '#ef476f');
            root.style.setProperty('--info-color', '#118ab2');
        }

        // Notify canvas renderers to update their colors
        document.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme } }));

        this.logger?.info(`Theme applied: ${theme}`);
    };

    if (typeof window !== 'undefined') window.SettingsTheme = SettingsTheme;
})();
