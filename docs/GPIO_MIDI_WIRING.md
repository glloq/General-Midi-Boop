# MIDI Serie via GPIO - Guide de cablage

Ce guide explique comment connecter des instruments MIDI aux broches GPIO du Raspberry Pi en utilisant le protocole MIDI serie standard (31250 baud, 8N1).

## Sommaire

1. [Compatibilite Raspberry Pi](#compatibilite-raspberry-pi)
2. [Circuit MIDI OUT](#circuit-midi-out)
3. [Circuit MIDI IN](#circuit-midi-in)
4. [Configuration du Raspberry Pi](#configuration-du-raspberry-pi)
5. [Correspondance UARTs par modele](#correspondance-uarts-par-modele)
6. [Liste des composants](#liste-des-composants)
7. [Depannage](#depannage)

---

## Compatibilite Raspberry Pi

| Modele | UARTs disponibles | Notes |
|--------|-------------------|-------|
| **Pi 3B/3B+** | 1 (mini UART partage avec BT) | Il faut desactiver le Bluetooth pour liberer UART0 |
| **Pi 4B** | Jusqu'a 6 (UART0 + UART2-5 via overlays) | Recommande - meilleur support multi-UART |
| **Pi 5** | Jusqu'a 5 UARTs natifs | Meilleur DMA, timing MIDI precis |
| **Pi Zero 2W** | 1 (mini UART partage avec BT) | Comme le Pi 3, desactiver BT pour UART0 |

---

## Circuit MIDI OUT (GPIO TX vers DIN 5 broches)

Le circuit MIDI OUT envoie les donnees du Raspberry Pi vers un instrument MIDI.

### Schema

```
                    DIN-5 Female (vue de face, cote soudure)
                    ┌─────────────┐
                    │  5       4  │
                    │    2        │
                    │  1       3  │
                    └─────────────┘

Raspberry Pi                              DIN-5 Female
─────────────                             ────────────

GPIO TX ──── [220 ohm] ─────────────────── Pin 5 (Data)

3.3V ─────── [220 ohm] ─────────────────── Pin 4 (Source +5V via resistances)

GND ────────────────────────────────────── Pin 2 (Shield/GND)
```

### Explication

- La specification MIDI utilise une boucle de courant. Le TX du Pi commute le courant a travers les resistances.
- Les resistances de 220 ohm limitent le courant a environ 5mA (norme MIDI).
- **Important** : Le Pi fonctionne en 3.3V. La plupart des recepteurs MIDI modernes acceptent cette tension, mais certains instruments anciens (5V) peuvent necessiter un buffer de niveau (74HCT04 ou SN7407).

### Schema avec buffer de niveau (optionnel, pour instruments 5V)

```
GPIO TX ──── [220 ohm] ── 74HCT04 ── [220 ohm] ── DIN Pin 5
5V ───────── [220 ohm] ──────────────────────────── DIN Pin 4
GND ─────────────────────────────────────────────── DIN Pin 2
```

---

## Circuit MIDI IN (DIN 5 broches vers GPIO RX)

Le circuit MIDI IN recoit les donnees d'un instrument MIDI vers le Raspberry Pi. Un optocoupler (6N138) est **obligatoire** pour isoler electriquement les deux appareils.

### Schema

```
DIN-5 Female                  6N138 Optocoupler              Raspberry Pi
────────────                  ─────────────────              ─────────────

                              ┌────────┐
Pin 5 ── [220 ohm] ─────── 2 │ Anode  │
                              │        │
Pin 4 ───────────────────── 3 │Cathode │
                              │        │
                            5 │ GND    │──────────── GND
                              │        │
3.3V ─────── [470 ohm] ─── 8 │ Vcc    │
                              │        │
3.3V ─── [10k ohm] ──┬──── 6 │ Output │──────────── GPIO RX
                      │       │        │
                      │     7 │ Vb     │
                      │       └────────┘
                      │
                      └──── vers GPIO RX
```

### Brochage du 6N138

```
        ┌────────┐
    1 ──│ NC     │── 8  Vcc (3.3V via 470 ohm)
    2 ──│ Anode  │── 7  Vb (laisser flottant ou connecter a Vcc)
    3 ──│Cathode │── 6  Output (vers GPIO RX + pull-up 10k)
    4 ──│ NC     │── 5  GND
        └────────┘
```

### Explication

- L'optocoupler isole electriquement l'emetteur MIDI du Raspberry Pi (protection contre les boucles de masse).
- La resistance de 220 ohm sur l'anode (pin 2) limite le courant de la LED interne.
- Le pull-up de 10k ohm sur la sortie (pin 6) assure un signal propre pour le GPIO RX.
- La diode 1N4148 (optionnelle) en anti-parallele sur l'anode peut proteger contre les inversions de polarite.

### Version complete avec protection

```
DIN Pin 4 ──── ┐
               1N4148 (cathode vers pin 4)
DIN Pin 5 ── [220 ohm] ──┤
                          ├── 6N138 Pin 2 (Anode)
DIN Pin 4 ────────────────┘── 6N138 Pin 3 (Cathode)

3.3V ── [470 ohm] ── 6N138 Pin 8 (Vcc)
3.3V ── [10k ohm] ──┬── 6N138 Pin 6 (Output) ── GPIO RX
                     │
6N138 Pin 5 (GND) ── GND
```

---

## Configuration du Raspberry Pi

### Raspberry Pi 3B/3B+

```bash
# /boot/config.txt (ou /boot/firmware/config.txt sur les OS recents)

# Desactiver le Bluetooth pour liberer UART0 (PL011) sur GPIO14/15
dtoverlay=disable-bt

# Desactiver le service Bluetooth systemd
sudo systemctl disable hciuart
```

Apres modification, un seul UART est disponible : `/dev/ttyAMA0` (GPIO14 TX, GPIO15 RX).

### Raspberry Pi 4B (recommande)

```bash
# /boot/config.txt

# Option 1 : Desactiver le Bluetooth pour liberer UART0
dtoverlay=disable-bt

# Option 2 : Garder le Bluetooth et utiliser les UARTs supplementaires
# (UART0 reste utilise par BT, mais UART2-5 sont disponibles)

# Activer des UARTs supplementaires (choisir selon les GPIO disponibles) :
dtoverlay=uart2    # UART2 sur GPIO0 (TX) / GPIO1 (RX)
dtoverlay=uart3    # UART3 sur GPIO4 (TX) / GPIO5 (RX)
dtoverlay=uart4    # UART4 sur GPIO8 (TX) / GPIO9 (RX)
dtoverlay=uart5    # UART5 sur GPIO12 (TX) / GPIO13 (RX)
```

### Raspberry Pi 5

```bash
# /boot/firmware/config.txt

# Le Pi 5 utilise un chipset different (RP1)
# UART0 est sur GPIO14/15 par defaut
dtoverlay=uart0-pi5

# UARTs supplementaires
dtoverlay=uart2-pi5    # GPIO0/1
dtoverlay=uart3-pi5    # GPIO4/5
dtoverlay=uart4-pi5    # GPIO8/9
```

### Permissions utilisateur (tous modeles)

```bash
# Ajouter l'utilisateur au groupe dialout pour acceder aux ports serie
sudo usermod -aG dialout $USER

# Redemarrer pour appliquer
sudo reboot
```

### Verifier la configuration

```bash
# Lister les ports serie disponibles
ls -la /dev/ttyAMA*

# Tester la vitesse 31250 baud
stty -F /dev/ttyAMA0 31250

# Verifier les overlays actifs
dtoverlay -l
```

---

## Correspondance UARTs par modele

### Raspberry Pi 4B

| UART | Device | GPIO TX | GPIO RX | Overlay |
|------|--------|---------|---------|---------|
| 0 | /dev/ttyAMA0 | GPIO14 (pin 8) | GPIO15 (pin 10) | `disable-bt` ou par defaut |
| 2 | /dev/ttyAMA1 | GPIO0 (pin 27) | GPIO1 (pin 28) | `uart2` |
| 3 | /dev/ttyAMA2 | GPIO4 (pin 7) | GPIO5 (pin 29) | `uart3` |
| 4 | /dev/ttyAMA3 | GPIO8 (pin 24) | GPIO9 (pin 21) | `uart4` |
| 5 | /dev/ttyAMA4 | GPIO12 (pin 32) | GPIO13 (pin 33) | `uart5` |

### Raspberry Pi 3B/3B+

| UART | Device | GPIO TX | GPIO RX | Notes |
|------|--------|---------|---------|-------|
| 0 (PL011) | /dev/ttyAMA0 | GPIO14 (pin 8) | GPIO15 (pin 10) | Necessite `disable-bt` |
| 1 (mini) | /dev/ttyS0 | GPIO14 (pin 8) | GPIO15 (pin 10) | Par defaut (instable a 31250 baud) |

> **Attention** : Le mini UART du Pi 3 est lie a la frequence du CPU et peut etre instable a 31250 baud. Utilisez toujours le PL011 (UART0) avec `dtoverlay=disable-bt`.

### Raspberry Pi 5

| UART | Device | GPIO TX | GPIO RX | Overlay |
|------|--------|---------|---------|---------|
| 0 | /dev/ttyAMA0 | GPIO14 (pin 8) | GPIO15 (pin 10) | `uart0-pi5` |
| 2 | /dev/ttyAMA1 | GPIO0 (pin 27) | GPIO1 (pin 28) | `uart2-pi5` |
| 3 | /dev/ttyAMA2 | GPIO4 (pin 7) | GPIO5 (pin 29) | `uart3-pi5` |
| 4 | /dev/ttyAMA3 | GPIO8 (pin 24) | GPIO9 (pin 21) | `uart4-pi5` |

---

## Liste des composants

### Pour un port MIDI OUT :

| Composant | Quantite | Ref |
|-----------|----------|-----|
| Resistance 220 ohm 1/4W | 2 | - |
| Connecteur DIN-5 femelle | 1 | Chassis ou cable |

### Pour un port MIDI IN :

| Composant | Quantite | Ref |
|-----------|----------|-----|
| Optocoupler 6N138 | 1 | (ou 6N139, H11L1) |
| Resistance 220 ohm 1/4W | 1 | Protection LED |
| Resistance 470 ohm 1/4W | 1 | Alimentation Vcc |
| Resistance 10k ohm 1/4W | 1 | Pull-up sortie |
| Diode 1N4148 | 1 | Protection (optionnel) |
| Connecteur DIN-5 femelle | 1 | Chassis ou cable |

### Pour un port MIDI IN + OUT complet :

Combiner les deux listes ci-dessus. Les composants sont peu couteux (<2 EUR par port).

### Alternatives commerciales (plug & play)

- **Pisound** (blokas.io) : HAT avec MIDI IN/OUT, audio, interface web
- **RPI-MIDI** : Shield MIDI simple pour Raspberry Pi
- **USB-MIDI adapter** : Cable USB vers DIN-5 (ne necessite pas de GPIO)

---

## Depannage

### Le port ne s'ouvre pas

```
Permission denied for /dev/ttyAMA0
```
Solution : `sudo usermod -aG dialout $USER && sudo reboot`

### Le port n'est pas detecte

```
Serial device not found: /dev/ttyAMA0
```
Solution : Verifier `/boot/config.txt` et les overlays UART. Redemarrer apres modification.

### Le 31250 baud n'est pas supporte

Le mini UART (`ttyS0`) du Pi 3 peut ne pas supporter 31250 baud de maniere fiable.
Solution : Utiliser le PL011 (`ttyAMA0`) avec `dtoverlay=disable-bt`.

### Les notes sont corrompues ou decalees

- Verifier le cablage (inversion TX/RX)
- Verifier la masse commune entre le Pi et l'instrument
- Verifier que le 6N138 est correctement alimente (pin 8 = Vcc)

### Le Bluetooth ne fonctionne plus

Normal si `dtoverlay=disable-bt` est active. Sur Pi 4, utiliser UART2-5 a la place pour garder le Bluetooth.
