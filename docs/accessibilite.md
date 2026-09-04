# Recette accessibilité et responsive (`OPS-07`)

Objectif de `DEC-01`/`OPS-07` : **aucun blocage WCAG A/AA connu sur les
parcours MVP**. Ce document dit ce qui est mesuré automatiquement, ce qui a
été corrigé, et ce qui relève encore d'un œil humain ou d'un lecteur d'écran
réel — parce qu'une recette qui prétend le contraire n'en est pas une.

## Ce qui est mesuré, à chaque exécution de la suite

`tests/e2e/accessibilite.spec.ts` + `tests/e2e/helpers/a11y.ts`.

| Critère WCAG | Ce qui est vérifié | Où |
| --- | --- | --- |
| 1.4.3 Contraste (AA) | contraste **rendu** de chaque nœud de texte, calculé contre la couleur réellement peinte derrière lui | `/login`, `/signup`, `/caisse`, `/stock`, `/bilan`, `/configuration` |
| 1.4.10 Redistribution | aucun débordement horizontal | 320, 375, 700, 768 et 1024 px |
| 2.5.8 Taille de cible (AA) | tout contrôle ≥ 44 px | écrans authentifiés à 375 px |
| 4.1.2 Nom, rôle, valeur | chaque contrôle a un nom accessible | mêmes écrans |
| 2.4.1 Contournement de blocs | le lien d'évitement est la première tabulation, visible au focus, et mène au contenu | `/caisse` |
| 2.4.7 Focus visible | tout élément focalisé porte un anneau | 14 tabulations |
| 2.1.2 Pas de piège au clavier | le focus ne quitte jamais une boîte de dialogue ouverte ; Échap ferme ; le focus revient à l'ouvrant | modale de mouvement |
| 2.1.1 Clavier | une vente complète se fait sans souris | table → produit → ticket |

Écrit à la main plutôt que tiré d'une bibliothèque : les deux questions qui
comptent ici — le contraste *rendu* et la taille des cibles sur une caisse
utilisée debout — se calculent exactement, et un outil générique aurait noyé
ces deux réponses sous cent constats.

Le contraste et le nommage sont audités à **deux largeurs** (375 et 1024) et
non cinq : la couleur ne dépend pas de la largeur, seule la mise en page
autour d'elle change, et cette application a deux mises en page. Les cinq
largeurs restent auditées pour le débordement, qui lui en dépend. Les auditer
toutes pour le contraste répétait quatre fois les mêmes constats et coûtait
assez de chargements pour que le serveur de développement lâche des
connexions ailleurs dans la suite.

## Ce que l'audit a trouvé, et qui est corrigé

**Cinq gris codés en dur que la correction de `UX-04` n'a jamais atteints.**
`UX-04` avait assombri le token `--muted` de `#718078` à `#526058` et l'avait
documenté — mais ces règles portaient leur *propre copie* de l'ancienne
valeur, donc rien ne leur est parvenu : libellés de navigation (3,06:1),
onglets de période (3,98:1), légendes de KPI (4,11:1), lignes de ventilation
(4,15:1), et une carte de la caisse. Tous pointent désormais sur le token.

**`.split b` peignait `--ink` sur la carte vert foncé : 1,35:1.** Les montants
de la ventilation de caisse — « Fond 150,00 € Ventes 0,00 € » — étaient
pratiquement invisibles. Seul `.kpi-label` avait reçu une variante claire ;
`.split`, `.split b` et `.delta` n'en avaient aucune.

**`.pill.busy` à 4,04:1** — le badge qui dit « table occupée » à travers une
salle. Trouvé seulement au second passage : le premier avait tourné sur un
plan de salle où toutes les tables étaient libres, ce qui n'est l'écran de
personne. Le test crée maintenant cet état au lieu de l'attendre.

**Quatre cibles sous le minimum.** Le badge de réapprovisionnement du stock
rendait 69×21 — sous les 24×24 de WCAG 2.2 AA, et loin de ce qu'un pouce
trouve. Les onglets de filtre du bilan rendaient 23 px de haut parce qu'ils
vivaient dans un conteneur `.segmented` **sans porter la classe `.segment`** :
le même composant implémenté deux fois, dont la moitié n'avait jamais reçu le
dimensionnement. Partager la définition unique était la correction ; une
seconde règle CSS aurait recréé la divergence.

## Ce qui n'est pas un défaut, et pourquoi

**Les liens en ligne dans une phrase** (« Pas encore de compte ? *Créer mon
établissement* ») restent à la hauteur du texte. WCAG 2.5.8 les exempte
explicitement, et les rembourrer à 44 px casserait la phrase autour d'eux.

**`NEXTJS-PORTAL` et `body` pendant la tabulation.** Le premier est l'hôte de
la surcouche d'erreur du serveur de développement — il n'existe pas dans une
version de production. Le second est ce que rapporte `document.activeElement`
pendant que le focus traverse la barre du navigateur au bouclage. Une version
antérieure de ces tests échouait sur les deux et m'aurait fait « corriger »
un défaut inexistant, y compris un piège de focus qui fonctionne
parfaitement.

## Ce qui reste à un humain

Rien de ce qui suit ne peut être automatisé honnêtement, et rien de ce qui
suit n'est déclaré conforme ici.

- **Un lecteur d'écran réel** (VoiceOver, NVDA). La suite vérifie que chaque
  contrôle *a* un nom ; elle ne peut pas dire si l'enchaînement annoncé est
  compréhensible, si l'ordre de lecture d'un ticket a du sens, ni si les
  régions live parlent au bon moment.
- **Le jugement visuel**, en particulier sur un vrai téléphone en plein
  service : densité, hiérarchie, lisibilité à bout de bras, atteignabilité au
  pouce d'une seule main.
- **Le zoom à 200 %** (WCAG 1.4.4) et l'espacement de texte (1.4.12), qui
  demandent une inspection à l'œil de ce qui se chevauche.
- **Le mouvement et les préférences système** (`prefers-reduced-motion`) :
  l'application n'anime presque rien, mais cela n'a pas été audité.

## Rejouer la recette

```bash
pnpm test:e2e tests/e2e/accessibilite.spec.ts
```
