# Reprise — Bug : mains piano qui se déplacent avec la vue

## Branche de travail
`claude/fix-piano-hand-position-aSpiO`

## État actuel (commit b9847a1)
Un premier fix a été committé (b9847a1) : snap de `rangeMin` vers une touche
blanche dans `_panKeyboard`, `_zoomKeyboard` et `_mountKeyboard`.
L'utilisateur a confirmé que ce fix est **insuffisant** — "la main 2 se ballade
encore avec le déplacement de la vue depuis la minimap".

---

## Causes racines identifiées (analyse complète)

### Cause 1 — Direction de snap incohérente dans `_whiteKeysFromAnchor`

**Fichier** : `KeyboardHandPositionState.js` vs `KeyboardFingersRenderer.js`

- `KeyboardHandPositionState._whiteKeysFromAnchor` : snap **FORWARD** (`m++`)
  pour les touches noires
- `KeyboardFingersRenderer._whiteKeysFromAnchor` : snap **BACKWARD** (`m--`)
  pour les touches noires

Conséquence : pour une ancre sur une touche noire (ex. 61 = C#4 pendant le
lerp d'animation), l'état (`currentBands`) place la bande à partir de 62 (D4),
mais le renderer dessine les doigts à partir de 60 (C4).

Lorsque `rangeMin` change (pan), le filtre `m >= rangeMin` peut couper la touche
60 (si rangeMin = 61 ou 62), faisant sauter les doigts à la touche suivante
visible — c'est le "wandering".

**Fix à appliquer** dans `KeyboardFingersRenderer.js` ligne ~473 :
```javascript
// AVANT
if (this._isBlackKey(m)) m--;

// APRÈS
if (this._isBlackKey(m)) m++;  // snap FORWARD comme KeyboardHandPositionState
```

---

### Cause 2 — `_initialAnchorFor` ne snappe pas sur une touche blanche

**Fichier** : `KeyboardHandPositionState.js` ligne ~616

Le seed de l'ancre initiale peut tomber sur une touche noire (ex. seed=39=D#3
pour un piano 88 touches avec 2 mains). Cela crée une incohérence dès le
départ.

**Fix à appliquer** dans `_initialAnchorFor` :
```javascript
_initialAnchorFor(hand, i, total) {
    const ext = this.range;
    const seed = ext.lo + Math.round(((i + 0.5) / Math.max(1, total))
        * (ext.hi - ext.lo - hand.span));
    const overrideAnchor = this._latestAnchorOverride(hand.id);
    const raw = Number.isFinite(overrideAnchor) ? overrideAnchor : seed;
    const clamped = Math.max(ext.lo, Math.min(ext.hi - hand.span, raw));
    // NOUVEAU : pour piano, snappe sur touche blanche
    return this.layout === 'piano' ? this._snapAnchor(clamped) : clamped;
}
```

`_snapAnchor(clamped)` avec un entier noir snappe FORWARD (m+1) — cohérent
avec `_whiteKeysFromAnchor`.

---

### Cause 3 — Trou dans le snap de `_panKeyboard` / `_zoomKeyboard`

**Fichier** : `KeyboardHandPositionEditorModal.js` lignes ~690 et ~663

```javascript
// CONDITION ACTUELLE (échoue quand lo == full.lo et full.lo est noir)
while (_kbIsBlackKey(lo) && lo > full.lo) lo--;

// FIX : snap vers le bas d'abord, puis vers le haut si on est au plancher
if (this._keyboardLayoutType() === 'piano') {
    while (_kbIsBlackKey(lo) && lo > full.lo) lo--;
    if (_kbIsBlackKey(lo)) {
        // full.lo lui-même est noir : snappe vers le haut
        while (_kbIsBlackKey(lo) && lo <= full.hi) lo++;
    }
}
```

Même fix dans `_zoomKeyboard` (même pattern, ligne ~663).

---

## Fichiers à modifier

1. **`public/js/features/auto-assign/KeyboardFingersRenderer.js`**
   - Ligne ~473 : `_whiteKeysFromAnchor` → `m++` au lieu de `m--`

2. **`public/js/features/auto-assign/KeyboardHandPositionState.js`**
   - Ligne ~616 : `_initialAnchorFor` → appel `_snapAnchor` à la fin

3. **`public/js/features/auto-assign/KeyboardHandPositionEditorModal.js`**
   - Ligne ~690 (`_panKeyboard`) : snap hole fix
   - Ligne ~663 (`_zoomKeyboard`) : même snap hole fix

---

## Vérifications après fix

- Lancer les tests existants :
  ```
  cd /home/user/General-Midi-Boop
  npm test -- tests/frontend/keyboard-preview.test.js
  npm test -- tests/frontend/hand-position-editor-modal.test.js
  ```
- Vérifier visuellement : ouvrir le modal piano, faire glisser la minimap
  clavier → les doigts doivent rester sur leurs touches, pas bouger avec la vue.

---

## Ce qui a déjà été committé
- `b9847a1` : snap rangeMin vers touche blanche (fix partiel, insuffisant seul)

## Ce qui reste à faire (dans l'ordre)
1. Appliquer les 3 causes racines ci-dessus (Causes 1, 2, 3)
2. Lancer les tests pour vérifier pas de régression
3. Committer et pusher sur la branche `claude/fix-piano-hand-position-aSpiO`
