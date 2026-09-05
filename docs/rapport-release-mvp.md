# Rapport de release MVP (`REL-01`)

**Date** : 5 septembre 2026
**Décision : GO pour le pilote**, sous les six conditions de déploiement
listées en fin de document.

---

## Décompte

| | |
| --- | --- |
| Tickets terminés | **117** |
| Tickets ouverts | **1** (`REL-01`, ce rapport) |
| `P0` ouverts | **0** |
| `P1` ouverts | **0** |

## Portes

| Porte | État | Sur quoi elle repose |
| --- | --- | --- |
| `GATE-0` Décisions | ✅ | `DEC-01` à `DEC-11` validées, périmètre MVP figé |
| `GATE-1` Projet reproductible | ✅ | `pnpm install && pnpm dev` depuis une copie neuve ; CI verte |
| `GATE-2` Périmètre sécurisé | ✅ | Session exigée, requêtes scopées, rôles vérifiés côté serveur |
| `GATE-3` Encaissement fiable | ✅ | Prix serveur, paiements égaux au total, pas de stock négatif, idempotence |
| `GATE-4A` Salle exploitable | ✅ | Un ticket par table occupée, reprise après rechargement, une seule vente directe |
| `GATE-4B` Établissement configurable | ✅ | Configuration sans SQL, fuseau/devise/TVA réellement appliqués |
| `GATE-5` Exploitation réconciliable | ✅ | Journée ouvrable/comptable/clôturable, stock reconstructible depuis son registre |
| `GATE-6` Pilotage fiable | ✅ | Aucun contenu mocké, chaque KPI défini et testé, exports filtrés |
| `GATE-7` MVP pilote | ⚠️ **5 sur 6** | Détail ci-dessous |

### `GATE-7`, critère par critère

| Critère | État | Preuve |
| --- | --- | --- |
| Un client peut être onboardé sans intervention en base | ✅ | `pnpm test:e2e:fresh` : le parcours complet passe sur une base **migrée et non semée** — zéro organisation, zéro compte, zéro produit au départ |
| Les trois rôles disposent uniquement de leurs permissions | ✅ | `OPS-06B` fait travailler chaque rôle une journée entière ; `OPS-08`/`08B` vérifient les refus côté serveur, y compris sur les lectures |
| Sauvegarde, restauration, logs, alertes et rollback opérationnels | ✅ | Exercice de restauration rejoué à chaque suite ; alertes de fraîcheur de sauvegarde ; rollback détecté par la sonde de disponibilité |
| Les parcours complets passent sur mobile, tablette et desktop | ✅ | `tests/e2e/parcours-mobile.spec.ts` : journée entière à 375 et 768 px, `parcours-complet.spec.ts` au-delà |
| Aucun `P0`, aucune vulnérabilité critique/élevée, aucun mock silencieux | ✅ | 0 ticket `P0`/`P1` ouvert ; revue de sécurité sans finding critique/élevé ; `pnpm audit` propre |
| Le gérant pilote une journée complète et explique ventes, caisse et stock | ⏳ | **Ne peut pas être vérifié avant le pilote : c'est le pilote.** À constater le premier jour, avec le gérant. |

Le dernier critère n'est pas un manque à combler avant de partir — c'est
l'objet même de la mise en service. Le cocher d'avance serait une fausse
déclaration.

## Chaîne de qualité, au moment de la décision

| Étape | Résultat |
| --- | --- |
| `pnpm lint` | 0 erreur, **0 avertissement** |
| `pnpm format:check` | conforme |
| `pnpm typecheck` | conforme |
| `pnpm test` | **692 tests**, 55 fichiers |
| `pnpm test:e2e` | **130 tests** navigateur |
| `pnpm test:e2e:fresh` | parcours complet sur base non semée |
| `pnpm build` | succès |
| `pnpm audit --audit-level=high` | aucune vulnérabilité connue |

## Rollback disponible

Trois niveaux, tous exercés :

1. **Version applicative** — redéployer l'image précédente. Les migrations
   étant en avant seulement, `/api/health/ready` compare le schéma de la base
   aux migrations de l'image et distingue « déploiement inachevé » de
   « rollback » ; dans les deux cas le conteneur est marqué non sain et cesse
   de recevoir du trafic, pendant que la sonde de vivacité reste verte.
2. **Données** — `pnpm db:restore` restaure une sauvegarde dans une base
   isolée, avec vérification d'empreinte avant toute destruction. Cible RTO de
   `DEC-10` : 4 h ouvrées pour l'environnement complet.
3. **Client** — export complet puis anonymisation ; la purge reste refusée
   tant que courent les six ans comptables.

## Ce qui n'est pas couvert, et qui doit être su

Rien de ce qui suit n'est déclaré conforme :

- **Un lecteur d'écran réel.** La suite vérifie que chaque contrôle *a* un
  nom, pas que l'enchaînement annoncé est compréhensible.
- **Le transport de courrier.** Il n'en existe aucun : pas d'invitation par
  e-mail, pas de lien de réinitialisation envoyé, pas d'alerte routée. Les
  alertes sont rendues déjà qualifiées pour qu'un collecteur externe les
  route ; le mot de passe initial d'un employé se communique de vive voix.
- **TLS, domaine et reverse proxy réels.** L'application fait sa part
  (cookies `Secure`, HSTS derrière `X-Forwarded-Proto`), la terminaison TLS
  attend une plateforme.
- **Le stockage de sauvegardes hors machine et son chiffrement au repos.**
  En local les dumps sont en clair sur disque.
- **Le zoom à 200 %, l'espacement de texte et `prefers-reduced-motion`.**
- **Le fuseau d'affichage.** Les horodatages s'affichent dans le fuseau du
  navigateur, pas dans celui de l'établissement. Sans conséquence tant que
  les deux coïncident, ce qui est le cas d'un pilote local.

## Conditions du GO

Le feu est vert **à condition** que ces six points soient traités au
déploiement, pas après :

1. **Remplir le calendrier d'astreinte nominatif.** Une rotation sans nom par
   semaine veut dire personne : chacun suppose qu'un autre a vu l'alerte.
2. **Provisionner TLS, le domaine et le reverse proxy**, avec
   `X-Forwarded-Proto` transmis.
3. **Générer de vrais secrets.** `pnpm check:env` refuse de démarrer sur une
   valeur de développement ; le laisser faire son travail.
4. **Mettre en place le stockage de sauvegardes chiffré hors machine**, et
   vérifier l'alerte de fraîcheur la première semaine plutôt que de la
   supposer.
5. **Prendre une sauvegarde avant chaque déploiement portant une migration.**
   C'est la seule chose qui rend le rollback de données possible.
6. **Vérifier la séparation démo/pilote** avec `pnpm check:pilote` après la
   mise en service *et* après chaque restauration.

## Ce qui a été trouvé pendant la phase 7

Une revue qui ne trouve rien n'a pas cherché. Cette phase a produit, entre
autres :

- un écran de catalogue absent alors que `CFG-02` était coché — un client
  pouvait créer ses tables mais pas un seul produit ;
- une connexion qui réussissait pour un employé suspendu, puis l'éjectait ;
- deux lectures d'API sans garde de permission, dont l'historique complet des
  ventes accessible à un caissier ;
- cinq gris que la correction de contraste d'`UX-04` n'avait jamais atteints,
  et des montants à 1,35:1 sur la carte foncée du bilan ;
- des champs verrouillés qui ne le paraissaient pas, et des liens interdits
  affichés une fraction de seconde ;
- un build impossible sans les identifiants de la base de production ;
- un séparateur CSV qui aurait tarifé un produit 2 € au lieu de 2,50 €.

Aucune n'était visible dans une case cochée.

## Décision

**GO**, sous les six conditions ci-dessus.

Les huit premières portes sont validées et la neuvième l'est à cinq critères
sur six, le dernier étant le pilote lui-même. Aucun `P0` ni `P1` n'est ouvert,
la revue de sécurité ne laisse aucun finding critique ou élevé, et le
rollback est disponible aux trois niveaux.

Ce qui reste — TLS, courrier, sauvegardes hors machine — relève d'une
plateforme et non du produit, et chacun de ces points est nommé plutôt que
supposé résolu.
