# Contrats WebSocket — Méthode de capture et validation

> Ce document définit le processus de génération, stockage et validation
> des snapshots de contrats WS utilisés comme filet de sécurité pendant la
> refactorisation. Référence : [`REFACTORING_PLAN.md` §6 Phase 0](../../REFACTORING_PLAN.md).

## 1. Objectif

Chaque commande WS critique possède un **snapshot figé** de son contrat
(entrée attendue + sortie produite). Les tests de contrat vérifient
automatiquement que le refactoring ne casse pas ces payloads.

## 2. Protocole WS — rappel

### Message entrant (client → serveur)

```json
{
  "id": "<request-id>",
  "command": "<command_name>",
  "data": { ... },
  "version": 1
}
```

### Réponse succès (serveur → client)

```json
{
  "id": "<request-id>",
  "type": "response",
  "command": "<command_name>",
  "version": 1,
  "data": { ... },
  "timestamp": 1713000000000,
  "duration": 12
}
```

### Réponse erreur (serveur → client)

```json
{
  "id": "<request-id>",
  "type": "error",
  "command": "<command_name>",
  "error": "<message>",
  "code": "ERR_VALIDATION | ERR_NOT_FOUND | ...",
  "timestamp": 1713000000000
}
```

Champs dynamiques (exclus des snapshots) : `timestamp`, `duration`, `id`.

## 3. Format d'un snapshot de contrat

Chaque contrat est un fichier JSON dans `docs/refactor/contracts/<domaine>/`.

```
contracts/
  playback/
    playback_start.contract.json
    playback_stop.contract.json
    ...
  routing/
    route_create.contract.json
    ...
```

### Structure d'un fichier `.contract.json`

```json
{
  "command": "playback_start",
  "module": "PlaybackCommands.js",
  "criticality": "high",
  "cases": [
    {
      "name": "nominal — start with fileId",
      "type": "success",
      "input": {
        "fileId": "file-001"
      },
      "output_shape": {
        "type": "response",
        "data": {
          "fileInfo": "object",
          "channels": "array",
          "outputDevice": "string|null",
          "routingsLoaded": "number"
        }
      },
      "output_snapshot": {
        "type": "response",
        "data": {
          "fileInfo": { "id": "file-001", "name": "test.mid", "duration": 120000, "tracks": 3 },
          "channels": [{ "channel": 0, "noteCount": 42, "program": 0 }],
          "outputDevice": "virtual-out",
          "routingsLoaded": 0
        }
      }
    },
    {
      "name": "error — missing fileId",
      "type": "error",
      "input": {},
      "output_shape": {
        "type": "error",
        "code": "ERR_VALIDATION",
        "error": "string"
      },
      "output_snapshot": {
        "type": "error",
        "code": "ERR_VALIDATION",
        "error": "fileId is required"
      }
    }
  ]
}
```

### Champs

| Champ | Obligatoire | Description |
|---|---|---|
| `command` | oui | Nom exact de la commande WS |
| `module` | oui | Fichier source du handler |
| `criticality` | oui | `high` / `medium` / `low` |
| `cases` | oui | Liste de cas (nominaux + erreurs) |
| `cases[].name` | oui | Description lisible du cas |
| `cases[].type` | oui | `success` ou `error` |
| `cases[].input` | oui | Objet `data` envoyé dans le message WS |
| `cases[].output_shape` | oui | Types attendus pour chaque champ (validation structurelle) |
| `cases[].output_snapshot` | oui | Valeur exacte attendue (validation stricte) |

### Conventions de types dans `output_shape`

- `"string"`, `"number"`, `"boolean"`, `"object"`, `"array"` — type JS
- `"string|null"` — nullable
- `"any"` — présent mais pas typé
- objet imbriqué `{ "field": "type" }` — structure récursive

## 4. Outil de génération des snapshots

Les snapshots sont capturés via des **tests Jest** qui exécutent les handlers
réels avec des mocks contrôlés, puis exportent le résultat.

### Patron de test de contrat

```js
// tests/contracts/playback.contract.test.js
import { jest, describe, test, expect } from '@jest/globals';
import contract from '../../docs/refactor/contracts/playback/playback_start.contract.json';

// Helpers réutilisables
function createMockApp() {
  return {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    midiPlayer: {
      loadFile: jest.fn().mockResolvedValue({
        id: 'file-001', name: 'test.mid', duration: 120000, tracks: 3
      }),
      clearChannelRouting: jest.fn(),
      setChannelRouting: jest.fn(),
      setChannelSplitRouting: jest.fn(),
    },
    database: {
      getRoutingsByFile: jest.fn().mockReturnValue([]),
    },
    deviceManager: {
      getDeviceList: jest.fn().mockReturnValue([
        { id: 'virtual-out', name: 'Virtual Out', type: 'output', enabled: true }
      ]),
    },
  };
}

function createMockWs() {
  const messages = [];
  return {
    readyState: 1,
    send: jest.fn((data) => messages.push(JSON.parse(data))),
    _messages: messages
  };
}

describe(`Contract: ${contract.command}`, () => {
  for (const testCase of contract.cases) {
    test(testCase.name, async () => {
      const app = createMockApp();
      const ws = createMockWs();
      const registry = new CommandRegistry(app);

      // Load only the module under test
      const mod = await import('../../src/api/commands/PlaybackCommands.js');
      mod.register(registry, app);

      await registry.handle(
        { id: 'test-id', command: contract.command, data: testCase.input },
        ws
      );

      const response = ws._messages[0];
      expect(response.type).toBe(testCase.type);

      if (testCase.type === 'error') {
        expect(response.code).toBe(testCase.output_snapshot.code);
        expect(response.error).toBe(testCase.output_snapshot.error);
      } else {
        // Validation structurelle : vérifier la forme
        for (const [key, expectedType] of Object.entries(testCase.output_shape.data || {})) {
          expect(response.data).toHaveProperty(key);
          if (expectedType !== 'any') {
            const types = expectedType.split('|');
            const actualType = response.data[key] === null ? 'null' : typeof response.data[key];
            const isArray = Array.isArray(response.data[key]);
            expect(
              types.includes(actualType) || (isArray && types.includes('array'))
            ).toBe(true);
          }
        }

        // Validation stricte : snapshot exact (champs stables uniquement)
        const { timestamp, duration, id, ...stable } = response;
        expect(stable.data).toEqual(testCase.output_snapshot.data);
      }
    });
  }
});
```

### Convention de nommage des tests

```
tests/contracts/<domaine>.contract.test.js
```

Domaines : `playback`, `routing`, `devices`, `files`, `midi`, `lighting`,
`instruments`, `system`, `serial`, `bluetooth`, `network`, `latency`,
`playlist`, `session`, `presets`, `string-instruments`.

## 5. Inventaire des commandes et criticité

### Priorité haute (P0 — Phase 0/1)

| Commande | Module | Criticité |
|---|---|---|
| `playback_start` | PlaybackCommands.js | high |
| `playback_stop` | PlaybackCommands.js | high |
| `playback_pause` | PlaybackCommands.js | high |
| `playback_resume` | PlaybackCommands.js | high |
| `playback_seek` | PlaybackCommands.js | high |
| `playback_status` | PlaybackCommands.js | high |
| `playback_set_loop` | PlaybackCommands.js | high |
| `playback_set_tempo` | PlaybackCommands.js | medium |
| `playback_transpose` | PlaybackCommands.js | medium |
| `playback_set_volume` | PlaybackCommands.js | medium |
| `playback_get_channels` | PlaybackCommands.js | high |
| `playback_set_channel_routing` | PlaybackCommands.js | high |
| `playback_clear_channel_routing` | PlaybackCommands.js | medium |
| `playback_mute_channel` | PlaybackCommands.js | medium |
| `analyze_channel` | PlaybackCommands.js | high |
| `generate_assignment_suggestions` | PlaybackCommands.js | high |
| `apply_assignments` | PlaybackCommands.js | high |
| `validate_instrument_capabilities` | PlaybackCommands.js | medium |
| `get_instrument_defaults` | PlaybackCommands.js | medium |
| `update_instrument_capabilities` | PlaybackCommands.js | medium |
| `get_file_routings` | PlaybackCommands.js | high |
| `playback_validate_routing` | PlaybackCommands.js | high |
| `playback_set_disconnect_policy` | PlaybackCommands.js | medium |
| `route_create` | RoutingCommands.js | high |
| `route_delete` | RoutingCommands.js | high |
| `route_list` | RoutingCommands.js | high |
| `route_enable` | RoutingCommands.js | high |
| `route_info` | RoutingCommands.js | medium |
| `filter_set` | RoutingCommands.js | medium |
| `filter_clear` | RoutingCommands.js | medium |
| `channel_map` | RoutingCommands.js | medium |
| `route_test` | RoutingCommands.js | medium |
| `file_routing_sync` | RoutingCommands.js | high |
| `file_routing_bulk_sync` | RoutingCommands.js | high |

### Priorité moyenne (P1 — Phase 2+)

| Commande | Module | Criticité |
|---|---|---|
| `file_upload` | FileCommands.js | high |
| `file_list` | FileCommands.js | high |
| `file_metadata` | FileCommands.js | medium |
| `file_delete` | FileCommands.js | high |
| `device_list` | DeviceCommands.js | high |
| `device_info` | DeviceCommands.js | medium |
| `device_enable` | DeviceCommands.js | medium |
| `instrument_update_settings` | InstrumentSettingsCommands.js | medium |
| `instrument_get_settings` | InstrumentSettingsCommands.js | medium |
| `instrument_list_connected` | InstrumentSettingsCommands.js | medium |

### Priorité basse (P2 — couverture étendue)

Toutes les autres commandes (lighting, bluetooth, serial, network, latency,
playlist, session, presets, string instruments, virtual instruments, system).
Elles seront couvertes après la stabilisation des domaines playback et routing.

## 6. Processus de revue

### Création d'un snapshot

1. L'agent identifie la commande à couvrir.
2. Il lit le handler source pour comprendre les entrées/sorties.
3. Il crée le fichier `.contract.json` avec cas nominal + cas d'erreur.
4. Il crée ou met à jour le test Jest correspondant.
5. Il lance `npm test -- tests/contracts/` et vérifie que tout passe.
6. Il note la commande comme couverte dans `PROGRESS.md`.

### Mise à jour d'un snapshot

Si un refactoring modifie légitimement un payload (ajout de champ, etc.) :

1. Le changement doit être **additif** (nouveau champ, pas de suppression).
2. Le snapshot est mis à jour **dans le même commit** que le changement de code.
3. Le commit message mentionne explicitement le changement de contrat.
4. Si le changement est **breaking** (suppression/renommage de champ) :
   un ADR est requis + versionnement de la commande (`v2:command_name`).

### Validation CI

Le répertoire `tests/contracts/` est inclus dans `npm test` via le pattern
Jest `**/tests/**/*.test.js`. Aucune configuration supplémentaire n'est
nécessaire.

## 7. Métriques de couverture

La couverture des contrats est suivie dans `PROGRESS.md` §Métriques :

```
Commandes WS critiques sous contrat : X / Y (Z %)
```

Cible Phase 0 : >= 90 % des commandes de criticité `high`.
