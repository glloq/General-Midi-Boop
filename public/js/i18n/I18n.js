/**
 * I18n - Lightweight internationalization manager for Général Midi Boop.
 * 28 locales (see supportedLocales); default/fallback is French.
 *
 * Usage:
 *   await i18n.init();
 *   i18n.t('settings.title');
 *   i18n.t('common.octaves', { count: 2 });
 */

(function (global) {
  'use strict';

  class I18n {
    constructor() {
      this.currentLocale = 'fr';
      this.fallbackLocale = 'fr';
      this.translations = {};
      this.supportedLocales = [
        'id',
        'cs',
        'da',
        'de',
        'en',
        'eo',
        'es',
        'tl',
        'fr',
        'it',
        'hu',
        'nl',
        'no',
        'pl',
        'pt',
        'fi',
        'sv',
        'vi',
        'tr',
        'el',
        'ru',
        'uk',
        'bn',
        'hi',
        'th',
        'ko',
        'ja',
        'zh-CN'
      ];
      this.localeNames = {
        id: 'Bahasa Indonesia',
        cs: 'Čeština',
        da: 'Dansk',
        de: 'Deutsch',
        en: 'English',
        eo: 'Esperanto',
        es: 'Español',
        tl: 'Filipino',
        fr: 'Français',
        it: 'Italiano',
        hu: 'Magyar',
        nl: 'Nederlands',
        no: 'Norsk',
        pl: 'Polski',
        pt: 'Português',
        fi: 'Suomi',
        sv: 'Svenska',
        vi: 'Tiếng Việt',
        tr: 'Türkçe',
        el: 'Ελληνικά',
        ru: 'Русский',
        uk: 'Українська',
        bn: 'বাংলা',
        hi: 'हिन्दी',
        th: 'ไทย',
        ko: '한국어',
        ja: '日本語',
        'zh-CN': '简体中文'
      };
      this.listeners = [];
      this.initialized = false;
    }

    /**
     * Initialize the i18n system
     * Loads the saved language or auto-detects it
     */
    async init() {
      if (this.initialized) {
        console.log('[I18n] Already initialized');
        return;
      }

      // Read the saved locale or auto-detect from the browser
      const savedLocale = localStorage.getItem('gmboop_locale');
      const browserLocale = navigator.language?.split('-')[0];

      let locale = savedLocale || browserLocale || this.fallbackLocale;

      // Check that the locale is supported
      if (!this.supportedLocales.includes(locale)) {
        locale = this.fallbackLocale;
      }

      await this.loadLocale(locale);
      this.updatePageTranslations();
      this.initialized = true;

      console.log(`[I18n] Initialized with locale: ${this.currentLocale}`);
    }

    /**
     * Load a translation file
     * @param {string} locale - Language code (fr, en, es)
     */
    async loadLocale(locale) {
      try {
        // Cache-bust to ensure fresh translations after updates
        const cacheBust = `v=${Date.now()}`;
        const response = await fetch(`/locales/${locale}.json?${cacheBust}`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        this.translations = await response.json();
        this.currentLocale = locale;
        this._translationCache = new Map(); // Invalidate cache on locale change
        localStorage.setItem('gmboop_locale', locale);

        // Update the HTML lang attribute
        document.documentElement.lang = locale;
      } catch (error) {
        console.warn(`[I18n] Failed to load locale "${locale}":`, error);

        // Fall back to the default language
        if (locale !== this.fallbackLocale) {
          console.log(`[I18n] Falling back to ${this.fallbackLocale}`);
          await this.loadLocale(this.fallbackLocale);
        }
      }
    }

    /**
     * Translate a key
     * @param {string} key - Translation key (e.g. "settings.title")
     * @param {Object} params - Parameters for interpolation
     * @returns {string|Array|Object} - Translated text, array, object, or the key when not found
     */
    t(key, params = {}) {
      // Fast path: cache hit for parameterless lookups
      const hasParams = Object.keys(params).length > 0;
      if (!hasParams && this._translationCache) {
        const cached = this._translationCache.get(key);
        if (cached !== undefined) return cached;
      }

      const keys = key.split('.');
      let value = this.translations;

      for (const k of keys) {
        if (value && typeof value === 'object' && k in value) {
          value = value[k];
        } else {
          console.warn(`[I18n] Missing translation: ${key}`);
          return key;
        }
      }

      // If it's an array, return it as-is
      if (Array.isArray(value)) {
        return value;
      }

      // If it's an object (not an array), return it as-is
      if (typeof value === 'object' && value !== null) {
        return value;
      }

      if (typeof value !== 'string') {
        console.warn(`[I18n] Translation is not a string: ${key}`);
        return key;
      }

      // Interpolate parameters: {param} → value
      const result = hasParams
        ? value.replace(/\{(\w+)\}/g, (match, name) => {
            return Object.hasOwn(params, name) ? params[name] : match;
          })
        : value;

      // Cache parameterless translations
      if (!hasParams && this._translationCache) {
        this._translationCache.set(key, result);
      }

      return result;
    }

    /**
     * Change the current language
     * @param {string} locale - Language code
     */
    async setLocale(locale) {
      if (!this.supportedLocales.includes(locale)) {
        console.warn(`[I18n] Unsupported locale: ${locale}`);
        return;
      }

      if (locale === this.currentLocale) {
        return;
      }

      await this.loadLocale(locale);
      this.updatePageTranslations();
      this.notifyListeners();

      console.log(`[I18n] Locale changed to: ${locale}`);
    }

    /**
     * Update every element carrying a data-i18n attribute
     */
    updatePageTranslations() {
      // [data-i18n attribute, DOM property to assign the translation to]
      const bindings = [
        ['data-i18n', 'textContent'],
        ['data-i18n-placeholder', 'placeholder'],
        ['data-i18n-title', 'title'],
        ['data-i18n-html', 'innerHTML']
      ];

      for (const [attr, prop] of bindings) {
        document.querySelectorAll(`[${attr}]`).forEach((el) => {
          const key = el.getAttribute(attr);
          const translation = this.t(key);
          if (translation !== key) {
            el[prop] = translation;
          }
        });
      }
    }

    /**
     * Return the current locale
     */
    getLocale() {
      return this.currentLocale;
    }

    /**
     * Return the list of supported locales
     */
    getSupportedLocales() {
      return this.supportedLocales.map((code) => ({
        code,
        name: this.localeNames[code]
      }));
    }

    /**
     * Add a listener for language changes
     * @param {Function} callback
     */
    onLocaleChange(callback) {
      this.listeners.push(callback);
      return () => {
        this.listeners = this.listeners.filter((cb) => cb !== callback);
      };
    }

    /**
     * Notify all listeners of the language change
     */
    notifyListeners() {
      this.listeners.forEach((callback) => {
        try {
          callback(this.currentLocale);
        } catch (error) {
          console.error('[I18n] Listener error:', error);
        }
      });
    }

    /**
     * Format a number according to the current locale
     * @param {number} number
     * @param {Object} options - Options Intl.NumberFormat
     */
    formatNumber(number, options = {}) {
      return new Intl.NumberFormat(this.currentLocale, options).format(number);
    }

    /**
     * Format a date according to the current locale
     * @param {Date} date
     * @param {Object} options - Options Intl.DateTimeFormat
     */
    formatDate(date, options = {}) {
      return new Intl.DateTimeFormat(this.currentLocale, options).format(date);
    }
  }

  // Singleton instance exposed globally
  global.i18n = new I18n();

  // Export for ES modules if available
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { i18n: global.i18n, I18n };
  }
})(typeof window !== 'undefined' ? window : this);
