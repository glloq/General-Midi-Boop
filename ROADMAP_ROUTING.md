# Roadmap - Refonte Modal de Routage

## Objectif
Finaliser le modal RoutingSummaryPage pour remplacer completement AutoAssignModal.
Interface intuitive, user-friendly, compatible avec le systeme de routage intelligent.

---

## Phase 1 : Panneau Routage Simple (gauche) -- COMPLETE
- [x] Creation roadmap et push initial
- [x] Dropdown instrument par canal (selection directe dans le tableau)
- [x] Score + nombre de notes jouables affiches par canal
- [x] Bouton "routage intelligent" par canal
- [x] Retirer badge SP, afficher instruments assignes si decoupe appliquee
- [x] Toggle adaptation automatique canal MIDI en haut du modal

## Phase 2 : Routage Intelligent (panneau droit) -- COMPLETE
- [x] Div gauche : info canal + liste instruments si multi-instruments
- [x] Div droite : plage MIDI complete 0-127
- [x] Representation deux lignes (notes canal + capacites instrument)
- [x] Transposition = deplacement direct des notes
- [x] Decoupe multi-instruments avec visualisation conflits
- [x] Proposition ajout instrument pour couvrir notes manquantes
- [x] Sauvegarde avec creation nouveaux canaux + refresh editeur

## Phase 3 : Minimap/Preview -- COMPLETE
- [x] Filtrer notes jouables uniquement en preview
- [x] Fix minimap non mise a jour au changement d'onglet
- [x] Boutons preview plus clairs/comprehensibles
- [x] Titre fichier a droite des boutons preview

## Phase 4 : Modal Reglages Simplifie -- COMPLETE
- [x] 3 presets : minimal, equilibre, orchestral
- [x] Reglages globaux (decoupe auto, instrument unique, type GM similaire)
- [x] Reglages drums avec fallback par categorie

## Phase 5 : Nettoyage Legacy -- COMPLETE
- [x] Remplacer AutoAssignModal par RoutingSummaryPage dans l'editeur
- [x] Retirer scripts legacy de index.html
- [x] Supprimer AutoAssignModal + 4 mixins
- [x] Retirer bouton Advanced et _openAdvancedModal() de RoutingSummaryPage

---

**Derniere mise a jour** : Toutes les phases completees
