// src/midi/AnalysisCache.js

/**
 * AnalysisCache - Cache LRU pour les analyses de canaux MIDI
 *
 * Évite de refaire les analyses coûteuses sur les mêmes fichiers/canaux
 */
class AnalysisCache {
  constructor(maxSize = 100, ttl = 600000) { // 10 minutes par défaut
    this.maxSize = maxSize;
    this.ttl = ttl; // Time to live en millisecondes
    this.cache = new Map();
    this.accessOrder = []; // Pour LRU
  }

  /**
   * Génère une clé de cache pour un fichier + canal
   * @param {number} fileId
   * @param {number} channel
   * @returns {string}
   */
  _generateKey(fileId, channel) {
    return `${fileId}:${channel}`;
  }

  /**
   * Récupère une analyse du cache
   * @param {number} fileId
   * @param {number} channel
   * @returns {Object|null}
   */
  get(fileId, channel) {
    const key = this._generateKey(fileId, channel);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Vérifier l'expiration
    const now = Date.now();
    if (now - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      this._removeFromAccessOrder(key);
      return null;
    }

    // Mettre à jour l'ordre d'accès (LRU)
    this._touch(key);

    return entry.data;
  }

  /**
   * Stocke une analyse dans le cache
   * @param {number} fileId
   * @param {number} channel
   * @param {Object} data
   */
  set(fileId, channel, data) {
    const key = this._generateKey(fileId, channel);

    // Si déjà présent, le retirer de l'ordre d'accès
    if (this.cache.has(key)) {
      this._removeFromAccessOrder(key);
    }

    // Vérifier la taille max et supprimer le plus ancien si nécessaire
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this._evictOldest();
    }

    // Ajouter au cache
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });

    // Ajouter à l'ordre d'accès
    this.accessOrder.push(key);
  }

  /**
   * Supprime une entrée du cache
   * @param {number} fileId
   * @param {number} channel
   */
  delete(fileId, channel) {
    const key = this._generateKey(fileId, channel);
    this.cache.delete(key);
    this._removeFromAccessOrder(key);
  }

  /**
   * Invalide toutes les analyses d'un fichier
   * @param {number} fileId
   */
  invalidateFile(fileId) {
    const prefix = `${fileId}:`;
    const keysToDelete = [];

    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
      this._removeFromAccessOrder(key);
    }
  }

  /**
   * Vide complètement le cache
   */
  clear() {
    this.cache.clear();
    this.accessOrder = [];
  }

  /**
   * Met à jour l'ordre d'accès (LRU)
   * @param {string} key
   * @private
   */
  _touch(key) {
    this._removeFromAccessOrder(key);
    this.accessOrder.push(key);
  }

  /**
   * Retire une clé de l'ordre d'accès
   * @param {string} key
   * @private
   */
  _removeFromAccessOrder(key) {
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  /**
   * Supprime l'entrée la plus ancienne (LRU)
   * @private
   */
  _evictOldest() {
    if (this.accessOrder.length === 0) {
      return;
    }

    const oldestKey = this.accessOrder[0];
    this.cache.delete(oldestKey);
    this.accessOrder.shift();
  }

  /**
   * Nettoie les entrées expirées
   */
  cleanup() {
    const now = Date.now();
    const keysToDelete = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
      this._removeFromAccessOrder(key);
    }
  }

  /**
   * Obtient les statistiques du cache
   * @returns {Object}
   */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttl: this.ttl,
      oldestEntry: this.accessOrder.length > 0 ? this.accessOrder[0] : null,
      newestEntry: this.accessOrder.length > 0 ? this.accessOrder[this.accessOrder.length - 1] : null
    };
  }
}

export default AnalysisCache;
