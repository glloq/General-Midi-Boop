# Audit d'uniformité des payloads d'erreur WS — Phase 3 (P1-3.4)

**Date** : 2026-04-17
**Scope** : `src/core/errors/index.js`, `src/api/CommandRegistry.js`,
`public/js/api/BackendAPIClient.js`, 26 snapshots de contrat WS avec
cas d'erreur.

## Format canonique retenu

Tous les handlers produisent, via `ApplicationError` et ses sous-classes,
des erreurs émises sur le WebSocket sous cette forme :

```json
{
  "id": "<request-id>",
  "type": "error",
  "command": "<command>",
  "error": "<human-readable message>",
  "code": "ERR_VALIDATION | ERR_NOT_FOUND | ERR_CONFIGURATION | ERR_MIDI | ERR_DATABASE | ERR_UNAUTHORIZED | ERR_APPLICATION",
  "timestamp": 1234567890
}
```

Sérialisation côté serveur : `src/api/CommandRegistry.js` L165-174.

## Inventaire des codes

### Déclarés dans `src/core/errors/index.js`

| Classe              | Code                  | Statut HTTP |
|---------------------|-----------------------|-------------|
| `ApplicationError`  | `ERR_APPLICATION`     | 500 (fallback) |
| `ValidationError`   | `ERR_VALIDATION`      | 400 |
| `NotFoundError`     | `ERR_NOT_FOUND`       | 404 |
| `AuthenticationError` | `ERR_UNAUTHORIZED`  | 401 |
| `ConfigurationError`  | `ERR_CONFIGURATION` | 500 |
| `MidiError`         | `ERR_MIDI`            | 500 |
| `DatabaseError`     | `ERR_DATABASE`        | 500 |

### Effectivement présents dans les snapshots `docs/refactor/contracts/**`

- `ERR_VALIDATION` — couvre la grande majorité des cas.
- `ERR_NOT_FOUND` — 5 snapshots (fichier / route / instrument introuvable).
- `ERR_CONFIGURATION` — 1 snapshot (`playback_start` sans device de sortie).
- `ERR_MIDI`, `ERR_DATABASE`, `ERR_UNAUTHORIZED` : **pas encore attestés**
  dans les snapshots publiés. Codes disponibles et utilisés dans le code
  applicatif mais non capturés en contrat WS. Acceptable — les classes
  existent et leurs payloads respectent le format canonique.

## Côté serveur — homogénéité vérifiée

1. **Handlers** (`src/api/commands/**`) : 0 occurrence de `throw new Error(...)`
   brut. Tous les lancers d'erreur métier passent par `ValidationError`,
   `NotFoundError`, `ConfigurationError`, `MidiError`. Audit effectué via
   `grep -r 'throw new Error' src/api/commands/` → vide.
2. **Validators déclaratifs** (Phase 3, ADR-004) : les messages produits
   par `SchemaCompiler` sont injectés dans un `ValidationError`
   (`CommandRegistry.js:118`) avec préfixe `Invalid <cmd> data: ` et
   jointure par `, `. Comportement identique aux snapshots P0-0.6.
3. **Erreurs non-ApplicationError** : `CommandRegistry.js:160-174` les
   remplace par `"Internal server error"` sans exposer le stack
   (protection anti-fuite).

## Côté client — `public/js/api/BackendAPIClient.js`

**Trouvaille** : `handleMessage` (lignes 141-159) traite uniquement
`message.error` (string) et le wrappe dans un simple `new Error(error)`.
**Le champ `code` n'est pas propagé** au consommateur de la promesse.

### Conséquence

Le code UI ne peut pas distinguer programmatiquement `ERR_VALIDATION`
de `ERR_NOT_FOUND` — il doit se rabattre sur un `match` de la string
`error.message`, ce qui est fragile.

### Recommandation (hors scope Phase 3 — à traiter en P2-OBS ou plus tard)

Remplacer :

```js
if (message.error) {
  pending.reject(new Error(message.error));
}
```

par :

```js
if (message.error || message.type === 'error') {
  const err = new Error(message.error || 'Unknown error');
  err.code = message.code;
  err.command = message.command;
  pending.reject(err);
}
```

Impact minimal : aucune rupture de contrat WS côté serveur, aucun
snapshot à modifier ; les callers continuent à voir un `Error` avec
un `.message` — ils peuvent en plus lire `.code` si utile.

Cette évolution **peut être faite sans ADR** car elle ne change pas
le format du message sur le fil ; elle n'ajoute qu'un décodage plus
riche côté client. À placer dans un todo de Phase 4 (observabilité
côté UI) plutôt que dans la Phase 3 actuelle.

## Conclusion

- **P1-3.4 clôturé** : le format d'erreur est uniforme sur tout
  `src/api/commands/**` ; les snapshots ne montrent que les 3 codes
  effectivement traversés par le parcours critique
  (`ERR_VALIDATION / ERR_NOT_FOUND / ERR_CONFIGURATION`).
- Aucune `throw new Error` brute n'échappe aux handlers.
- Une **amélioration opportune** (propagation de `code` côté client)
  est notée comme todo de Phase 4 — non bloquante.
