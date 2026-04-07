# Roadmap - Refonte Modal de Routage

## Objectif
Finaliser le modal RoutingSummaryPage pour remplacer completement AutoAssignModal.
Interface intuitive, user-friendly, compatible avec le systeme de routage intelligent.

---

## Phase 1 : Panneau Routage Simple (gauche)
- [x] Creation roadmap et push initial
- [ ] Dropdown instrument par canal (selection directe dans le tableau)
- [ ] Score + nombre de notes jouables affiches par canal
- [ ] Bouton "routage intelligent" par canal
- [ ] Retirer badge SP, afficher instruments assignes si decoupe appliquee
- [ ] Toggle adaptation automatique canal MIDI en haut du modal

## Phase 2 : Routage Intelligent (panneau droit)
- [ ] Div gauche : info canal + liste instruments si multi-instruments
- [ ] Div droite : plage MIDI complete 0-127
- [ ] Representation deux lignes (notes canal + capacites instrument)
- [ ] Transposition = deplacement direct des notes
- [ ] Decoupe multi-instruments avec visualisation conflits
- [ ] Proposition ajout instrument pour couvrir notes manquantes
- [ ] Sauvegarde avec creation nouveaux canaux + refresh editeur

## Phase 3 : Minimap/Preview
- [ ] Filtrer notes jouables uniquement en preview
- [ ] Fix minimap non mise a jour au changement d'onglet
- [ ] Boutons preview plus clairs/comprehensibles
- [ ] Titre fichier a droite des boutons preview

## Phase 4 : Modal Reglages Simplifie
- [ ] 3 presets : minimal, equilibre, orchestral
- [ ] Reglages globaux (decoupe auto, instrument unique, type GM similaire)
- [ ] Reglages drums avec fallback par categorie

## Phase 5 : Nettoyage Legacy
- [ ] Remplacer AutoAssignModal par RoutingSummaryPage dans l'editeur
- [ ] Retirer scripts legacy de index.html
- [ ] Supprimer AutoAssignModal + 4 mixins
- [ ] Nettoyer CSS inutile

---

**Derniere mise a jour** : Phase 1 en cours
