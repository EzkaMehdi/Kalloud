# Kalloud — vision produit, audit et feuille de route

> Document directeur du produit et point d’entrée des améliorations.
>
> Audit réalisé le 4 août 2026 sur le commit `2e5ed55`.
>
> Statut observé : prototype fonctionnel partiel, non prêt pour une utilisation réelle ni pour une mise en production SaaS.
>
> Plan d’exécution canonique : [`tasks.md`](./tasks.md). Les phases et identifiants du backlog initial des sections 13 et 14 restent du contexte d’audit ; seuls les identifiants de `tasks.md` doivent être utilisés pour piloter l’implémentation.

## 1. Comment utiliser ce document

Ce fichier doit rester la source de vérité avant toute évolution importante :

1. confirmer les décisions métier encore ouvertes ;
2. traiter les anomalies `P0` avant d’ajouter des fonctionnalités ;
3. transformer chaque chantier retenu en tickets courts avec critères d’acceptation ;
4. mettre à jour l’état des chantiers et les décisions prises ;
5. ne considérer une fonctionnalité comme terminée que si elle utilise des données réelles, gère les erreurs et possède au moins un test du parcours critique.

Les priorités utilisées ici sont :

- `P0 — Bloquant` : risque de données fausses, perte de caisse, faille de sécurité ou démarrage impossible ;
- `P1 — Important` : nécessaire pour livrer un produit fiable et utile au gérant ;
- `P2 — Évolution` : différenciation, automatisation ou passage à l’échelle.

## 2. Résumé exécutif

Kalloud vise un établissement de type lounge à chicha, café ou petite restauration. Le produit réunit trois besoins :

- prendre et encaisser une commande par table ou en vente directe ;
- suivre les stocks et les ruptures ;
- clôturer la caisse et piloter l’activité.

L’interface mobile-first est lisible et le périmètre initial est cohérent pour un petit établissement. L’intention technique d’encaisser une vente, décrémenter le stock et libérer la table dans une transaction unique est également saine.

Cependant, le dépôt est actuellement une démonstration, pas encore un SaaS :

- une installation neuve de la base n’applique pas le schéma attendu par l’API ;
- certains encaissements enregistrent une ventilation espèces/carte fausse ;
- le catalogue de caisse est codé en dur avec des identifiants qui ne correspondent pas à la base ;
- une table peut rester occupée sans qu’aucun ticket ne soit enregistré ;
- une partie visible du bilan est entièrement fictive ;
- les erreurs réseau sont souvent masquées par des données de démonstration ;
- il n’existe ni authentification, ni établissement, ni rôles, ni isolation des données ;
- l’API est publiquement modifiable si elle est exposée ;
- les dépendances déclarées présentent des vulnérabilités critiques connues.

La priorité n’est donc pas d’ajouter des graphiques ou des écrans. Il faut d’abord rendre chaque euro, chaque commande et chaque mouvement de stock traçable et fiable.

## 3. Objectif métier proposé

### Problème à résoudre

Un gérant de lounge/café travaille souvent avec plusieurs outils ou avec des notes manuelles. À la fin du service, il ne sait pas immédiatement :

- combien il a réellement encaissé ;
- ce qui doit se trouver dans la caisse ;
- quels produits ont le plus contribué au chiffre d’affaires et à la marge ;
- quelles ruptures menacent le prochain service ;
- quels écarts ou événements exigent une action.

### Promesse produit

**Kalloud permet à un établissement indépendant d’encaisser rapidement, de garder sa caisse et son stock cohérents, puis de terminer chaque service avec un bilan fiable et directement actionnable.**

### Utilisateurs cibles

- **Employé de salle / caissier** : ouvrir ou reprendre un ticket, encaisser sans erreur, signaler un mouvement de caisse.
- **Responsable de service** : voir les tables en cours, résoudre une rupture, contrôler la caisse et clôturer le service.
- **Gérant** : comprendre la performance, les écarts, les produits rentables et les actions prioritaires.
- **Administrateur du compte**, à terme : gérer les établissements, les utilisateurs, les rôles, le catalogue et la facturation SaaS.

### Jobs-to-be-done principaux

1. « Quand un client commande, je veux ouvrir ou reprendre son ticket en quelques secondes sans perdre les articles déjà saisis. »
2. « Quand j’encaisse, je veux que le paiement, le stock, la table et le chiffre d’affaires restent cohérents. »
3. « Quand je clôture, je veux comparer les espèces attendues aux espèces comptées et expliquer l’écart. »
4. « Avant le prochain service, je veux connaître les ruptures probables et la quantité à réapprovisionner. »
5. « En tant que gérant, je veux savoir ce qui a changé, pourquoi et quelle action prendre. »

### Indicateur directeur

Le meilleur indicateur directeur n’est pas le nombre d’écrans ni le nombre de graphiques :

**pourcentage de journées clôturées sans écart inexpliqué et avec toutes les ventes, paiements et sorties de stock réconciliés.**

Indicateurs complémentaires :

- temps médian de prise et d’encaissement d’une commande ;
- taux de journées clôturées le jour même ;
- valeur des écarts de caisse ;
- taux de produits en rupture pendant le service ;
- part des ventes correctement attribuées à un produit, un paiement et un employé ;
- taux d’utilisateurs actifs par établissement.

## 4. Positionnement recommandé

Kalloud ne doit pas devenir immédiatement un ERP généraliste. Le positionnement le plus crédible est :

**caisse et cockpit de pilotage simple pour lounges à chicha, cafés et petits établissements de service.**

Principes produit :

- privilégier la fiabilité transactionnelle à la richesse visuelle ;
- afficher une donnée uniquement si sa source et son périmètre sont fiables ;
- transformer les indicateurs en décisions, pas seulement en chiffres ;
- conserver un parcours de caisse utilisable sur mobile ou tablette ;
- rendre le mode démonstration explicite, jamais silencieux ;
- commencer avec un établissement, mais préparer l’isolation par établissement dans le modèle de données ;
- éviter les concepts doublonnés ou les actions sans résultat visible.

## 5. Ce que le produit fait réellement aujourd’hui

### Caisse

Fonctions reliées à une API :

- chargement des tables ;
- chargement du solde d’espèces et du chiffre d’affaires ;
- changement du statut d’une table ;
- enregistrement d’un mouvement de caisse ;
- encaissement atomique d’une commande ;
- clôture d’une journée et ouverture immédiate de la suivante.

Limites importantes :

- les produits du tiroir de commande viennent d’une constante locale, pas de la base ;
- le ticket n’est jamais sauvegardé avant l’encaissement ;
- fermer le tiroir fait perdre la commande ;
- toucher une table la passe immédiatement à « occupée », même sans article ;
- l’échec du changement de statut de la table est ignoré ;
- les données initiales restent affichées si l’API ne répond pas.

Références : `app/caisse/page.tsx:8-9`, `components/order-drawer.tsx:5-14`.

### Stock

Fonctions réelles :

- chargement des produits ;
- recherche locale par nom ;
- modification d’une quantité de stock.

Fonctions trompeuses ou incomplètes :

- le bouton principal « Recharger » ne recharge rien et affiche seulement une alerte ;
- l’ajout de quantité utilise `prompt()` et `alert()` ;
- l’écran affiche des données locales si l’API échoue, sans signaler qu’elles sont potentiellement fausses ;
- une modification remplace une quantité absolue calculée côté navigateur, ce qui peut écraser une mise à jour concurrente ;
- aucun journal de stock ne permet d’expliquer qui a modifié quoi et pourquoi.

Référence : `app/stock/page.tsx:5-6`.

### Bilan

Données réellement calculées par l’API :

- chiffre d’affaires ;
- chiffre d’affaires espèces ;
- chiffre d’affaires carte ;
- nombre de commandes ;
- panier moyen.

Données fictives :

- la liste des dernières commandes ;
- le journal de caisse visible ;
- les heures, tables, paiements et montants associés.

Action sans effet :

- le bouton « Voir tout » ne possède aucun gestionnaire.

Références : `app/bilan/page.tsx:5-7`, `server/index.js:71-77`.

### Éléments de démonstration non signalés

- plan de salle initial : `app/caisse/page.tsx:8` ;
- produits initiaux du stock : `app/stock/page.tsx:5` ;
- catalogue de la caisse : `components/order-drawer.tsx:5` ;
- commandes récentes : `app/bilan/page.tsx:5` ;
- mouvements du journal de caisse : `app/bilan/page.tsx:7` ;
- avatar « MK » sans compte utilisateur : `components/shell.tsx:3`.

Ces valeurs sont acceptables dans un mode démo explicite. Elles sont dangereuses comme repli silencieux, car un gérant peut les prendre pour des données réelles.

## 6. Audit des interactions visibles

### Caisse

- **Bouton “+” vente directe** : ouvre un panier local et encaisse réellement si l’API fonctionne. Il duplique cependant la table « Comptoir / Vente directe ».
- **Carte d’une table** : ouvre le panier, mais marque la table occupée avant toute commande et sans retour arrière fiable.
- **Bouton “Mouvement”** : enregistre une entrée ou une sortie réelle.
- **Bouton “Nouvelle journée”** : clôture réellement la journée courante puis en ouvre immédiatement une autre. Le libellé minimise une opération comptable importante.
- **Boutons de catégories et de produits** : fonctionnent localement, mais utilisent un catalogue statique.
- **Boutons quantité −/+** : fonctionnent localement, sans sauvegarde du brouillon.
- **Choix CB / Espèces / Mixte** : CB est le seul parcours cohérent. Espèces corrompt la ventilation et Mixte ne permet pas de saisir la répartition.
- **Bouton “Encaisser”** : appelle réellement l’API, mais met à jour l’interface avec le total client au lieu du total validé par le serveur.
- **Solde d’espèces après vente** : une vente payée en espèces augmente le chiffre d’affaires local, mais pas la carte « Espèces en caisse » avant rechargement.
- **Boutons de fermeture des tiroirs** : ferment bien les tiroirs, mais ne libèrent pas la table et ne demandent pas confirmation en cas de ticket saisi.

### Stock

- **Recherche** : fonctionne localement.
- **Bouton principal “Recharger”** : faux CTA ; il affiche seulement une consigne.
- **Pastille “En stock / À recharger / Rupture · +”** : met à jour la quantité via un dialogue natif, sans motif ni historique.
- **Recherche sans résultat** : affiche une carte vide sans message ni action de récupération.

### Bilan

- **Aujourd’hui / Ce mois / Cette année** : modifie la requête de KPI.
- **Sélecteur de mois** : force la période « Ce mois ».
- **Sélecteur d’année** : années codées en dur à 2025 et 2026.
- **Sélecteurs visibles avec “Aujourd’hui”** : ils semblent agir alors que la requête journalière les ignore.
- **Voir tout** : ne fait rien.
- **Commandes terminées et journal de caisse** : cartes statiques, non reliées aux endpoints pourtant présents.
- **Chargement et panne** : les zéros initiaux et historiques statiques restent affichés ; aucun chargement, message d’erreur ou bouton de nouvelle tentative n’existe.

## 7. Anomalies P0 — bloquantes

### P0-01 — Une installation neuve de la base est incohérente

Le `docker-compose.yml` exécute uniquement `schema.sql` et `seed.sql`. Il n’exécute pas `002-business-days.sql`.

Conséquences :

- la table `business_days` n’existe pas ;
- `orders.business_day_id` n’existe pas ;
- `cash_movements.business_day_id` n’existe pas ;
- l’API les interroge pourtant dès les parcours principaux ;
- le seed ne crée aucune journée active.

Preuves :

- `docker-compose.yml:14-15` ;
- `database/schema.sql:1-6` ;
- `database/002-business-days.sql:1-13` ;
- `server/index.js:10-28`.

Critères d’acceptation :

- un seul système de migrations versionnées ;
- une base vide devient utilisable avec une commande documentée ;
- la création initiale ouvre une journée ou guide explicitement l’utilisateur ;
- un test d’intégration démarre Postgres, applique les migrations et exécute un encaissement.

### P0-02 — La ventilation des paiements est fausse

Le client envoie :

- espèces : `cashAmount = total`, `cardAmount = 0` ;
- carte : `cashAmount = 0`, `cardAmount = total` ;
- mixte : `cashAmount = 0`, `cardAmount = 0`.

L’API enregistre `cardAmount || total`. Par conséquent :

- une vente espèces enregistre le total en espèces **et** en carte ;
- une vente mixte devient entièrement carte ;
- la somme espèces + carte peut être supérieure au chiffre d’affaires ;
- le bilan et le rapprochement de caisse deviennent faux.

Preuves : `components/order-drawer.tsx:13`, `server/index.js:83-90`.

Critères d’acceptation :

- pour `CASH`, carte = 0 et espèces = total ;
- pour `CARD`, espèces = 0 et carte = total ;
- pour `MIXED`, l’utilisateur saisit les deux montants ;
- le serveur impose `espèces + carte = total` ;
- des tests couvrent les trois moyens de paiement et les arrondis.

### P0-03 — Les identifiants du catalogue ne correspondent pas aux produits

Dans le seed, les identifiants 5, 6 et 7 correspondent respectivement à Café latte, Brunch Kalloud et Tiramisu. Dans le catalogue codé en dur de la caisse, ils sont associés à 7, 5 et 6.

Le dépôt contient plusieurs jeux de données (`seed.sql`, `demo-reset.sql`) avec des correspondances d’ID différentes. `docker-compose.yml` ne monte que `seed.sql`, où le décalage ci-dessus est réel. Avec `demo-reset.sql` exécuté séparément, les ID coïncident par coïncidence avec le catalogue codé en dur ; cela n’élimine pas le problème, cela l’aggrave : le comportement dépend silencieusement du dernier script SQL exécuté, tant que le catalogue reste codé en dur au lieu de venir de l’API.

Une sélection peut donc :

- décrémenter le mauvais produit ;
- utiliser un prix serveur différent du prix affiché ;
- incrémenter le chiffre d’affaires local avec un total différent du total enregistré.

Preuves : `database/seed.sql:3-10`, `components/order-drawer.tsx:5`, `server/index.js:86-90`.

Critères d’acceptation :

- le catalogue est chargé depuis l’API ;
- l’API retourne un identifiant stable, le prix, la disponibilité et la catégorie ;
- le client affiche le total retourné par le serveur après encaissement ;
- aucun produit en rupture ne peut être ajouté sans avertissement explicite.

### P0-04 — Le cycle de vie d’une commande par table n’existe pas

Une table passe à `OCCUPIED` dès qu’elle est touchée. Aucun ordre `PENDING` ni article n’est créé. Fermer le tiroir perd le panier et ne libère pas la table.

Le produit donne donc l’illusion d’un « ticket en cours » qui n’existe pas en base.

Preuves : `app/caisse/page.tsx:9`, `components/order-drawer.tsx:9-14`.

Critères d’acceptation :

- ouvrir une table crée ou reprend une commande persistée ;
- chaque ajout/suppression est sauvegardé ;
- fermer puis rouvrir conserve le ticket ;
- annuler un ticket demande confirmation et libère la table ;
- une table occupée ouvre son ticket existant ;
- la clôture du service bloque ou traite explicitement les tickets ouverts.

### P0-05 — L’interface masque les pannes et affiche de fausses données

Plusieurs requêtes ont un `catch(() => {})`. En cas de panne, les valeurs de démonstration restent visibles sans bannière, date de synchronisation ni mode hors-ligne.

Preuves : `app/caisse/page.tsx:9`, `app/stock/page.tsx:6`, `app/bilan/page.tsx:7`.

Critères d’acceptation :

- états distincts : chargement, succès, vide, erreur et hors-ligne ;
- aucune donnée démo en production ;
- si un mode démo existe, badge permanent et environnement dédié ;
- les mutations échouées sont annulées visuellement ou resynchronisées ;
- l’heure de dernière mise à jour est visible sur le bilan.

### P0-06 — Le produit n’a pas de socle SaaS ni de contrôle d’accès

Il n’existe aucune authentification, aucun rôle, aucun établissement et aucune isolation locataire. L’API accepte CORS depuis toutes les origines et expose les mutations de produits, tables, caisse et commandes.

Preuve : `server/index.js:6-8` et ensemble du schéma.

Critères d’acceptation :

- authentification obligatoire ;
- organisations et établissements isolés ;
- rôles minimum `OWNER`, `MANAGER`, `CASHIER` ;
- autorisation vérifiée côté serveur sur chaque lecture et mutation ;
- CORS limité aux origines attendues ;
- journal d’audit pour les opérations sensibles ;
- tests garantissant qu’un établissement ne lit ou ne modifie jamais les données d’un autre.

### P0-07 — Les dépendances présentent des vulnérabilités critiques

`pnpm audit --prod` rapporte 35 avis : 2 critiques, 12 élevés, 17 modérés et 4 faibles. Plusieurs avis concernent `next@15.1.0`, dont une exécution de code à distance liée au protocole React Flight et un contournement d’autorisation du middleware.

Ce nombre représente des avis de sécurité, pas nécessairement 35 chemins exploitables dans Kalloud. Les deux avis critiques imposent néanmoins une mise à niveau avant exposition.

Preuve : `package.json:11-23` et audit du 4 août 2026.

Critères d’acceptation :

- mise à niveau vers une version maintenue et corrigée de Next.js ;
- réexécution du build, des tests et de l’audit ;
- aucune vulnérabilité critique ou élevée acceptée sans analyse documentée ;
- automatisation de l’audit en CI.

### P0-08 — La clôture ne rapproche pas la caisse réelle

Le montant de clôture calculé utilise `fond initial + ventes espèces`. Il ignore les entrées et sorties du journal. L’interface ne demande pas les espèces réellement comptées ; elle demande seulement le fond de caisse de la prochaine journée.

Il est donc impossible de calculer et expliquer l’écart de caisse.

Preuves : `server/index.js:26-29`, `components/close-day-modal.tsx:7-11`.

Formule attendue :

`espèces attendues = fond initial + ventes espèces + entrées - sorties - retraits de fin de service`

`écart = espèces comptées - espèces attendues`

Critères d’acceptation :

- saisie séparée des espèces comptées et du prochain fond de caisse ;
- intégration de tous les mouvements ;
- affichage et justification obligatoire d’un écart au-delà d’un seuil ;
- clôture et ouverture séparées ou explicitement confirmées ;
- conservation de l’auteur et de l’horodatage.

### P0-09 — Une erreur de base peut arrêter l’API

Les handlers asynchrones ne passent pas leurs erreurs à un middleware global. Lors de la vérification, une requête sans Postgres disponible a provoqué une exception `ECONNREFUSED` puis l’arrêt du processus Node.

Preuves : `server/index.js:20-77` et vérification locale du 4 août 2026. Le risque dépasse les lectures : `pool.connect()` est appelé avant l’ouverture du bloc `try` dans les trois routes transactionnelles (`business-day/close`, `checkout`, `orders/:id/complete` — `server/index.js:27`, `:82`, `:97`), donc un encaissement ou une clôture peut lui aussi faire planter le processus si la base devient indisponible à cet instant précis. Plusieurs routes renvoient également `error.message` brut au client (`server/index.js:29,92,110`), ce qui peut exposer des détails internes PostgreSQL.

Critères d’acceptation :

- wrapper d’erreurs pour tous les handlers asynchrones ;
- middleware d’erreur avec réponse JSON stable et identifiant de corrélation ;
- endpoint de santé distinguant processus disponible et base disponible ;
- logs structurés sans fuite d’informations sensibles ;
- l’indisponibilité de Postgres renvoie `503` sans arrêter le serveur.

### P0-10 — Le déploiement réseau est inutilisable en l’état

Toutes les requêtes du navigateur ciblent `http://localhost:3001`. Sur une tablette ou un autre poste, `localhost` désigne l’appareil de l’utilisateur et non le serveur Kalloud. Depuis une application servie en HTTPS, ces appels HTTP seront également bloqués comme contenu mixte.

Le script `dev` ne démarre que Next.js et aucun script du package ne lance l’API.

Preuves : `package.json:5-9` et les appels `fetch` de `app/caisse/page.tsx:9`, `app/stock/page.tsx:6`, `app/bilan/page.tsx:7` et `components/*.tsx`.

Critères d’acceptation :

- appels same-origin de préférence, ou URL fournie par une configuration d’environnement validée ;
- aucune URL locale codée en dur dans le client ;
- HTTPS de bout en bout en production ;
- commande unique documentée pour démarrer les dépendances locales ;
- test depuis un second appareil ou navigateur isolé.

## 8. Chantiers P1 — produit fiable et utile

### P1-01 — Remplacer le bilan vitrine par un cockpit de décision

Les KPI actuels ne répondent pas à « pourquoi ? » ni à « que faire ? ». Les commandes et mouvements visibles sont fictifs.

À livrer :

- historique réel, filtrable et paginé ;
- comparaison à une période pertinente ;
- anomalies de caisse ;
- produits en rupture ou à risque ;
- principales hausses et baisses ;
- accès au détail depuis chaque indicateur ;
- export CSV au minimum.

### P1-02 — Créer un journal de stock

La quantité ne doit plus être une valeur modifiable sans explication.

Chaque mouvement doit contenir :

- produit ou ingrédient ;
- quantité signée ;
- type : vente, réception, correction, casse, perte, retour ;
- motif ;
- auteur ;
- date ;
- référence à la commande ou à l’inventaire.

Les mises à jour doivent être atomiques côté serveur.

### P1-03 — Définir le vrai modèle de stock

Une vente de « Chicha Signature » ne correspond probablement pas à une unité physique unique. Elle peut consommer tabac, charbon, embout et consommables.

Décision nécessaire :

- MVP simple : stock de produits finis ;
- cible métier : recettes et ingrédients avec unités et rendements.

Sans cette décision, la marge et les alertes de stock resteront peu fiables.

### P1-04 — Compléter les opérations de vente

Fonctions minimales à prévoir :

- annulation avant encaissement ;
- remboursement ou annulation après encaissement ;
- motif et autorisation manager ;
- remises encadrées ;
- TVA et prix TTC/HT ;
- reçu ou justificatif ;
- notes de commande ;
- historique non destructif.

### P1-05 — Validation et contrats d’API

L’API fait confiance aux corps JSON.

À livrer :

- schémas de validation partagés ;
- validation des identifiants, montants, quantités, périodes et enums ;
- erreurs métier stables ;
- interdiction des stocks négatifs ;
- agrégation des doublons d’un même produit avant contrôle du stock ;
- contrôle serveur de la somme des paiements ;
- tests de concurrence.

Un appel malveillant peut actuellement répéter deux fois le même produit dans `items`. Les contrôles lisent deux fois le stock avant les décréments, ce qui peut conduire à un stock négatif. Référence : `server/index.js:86-90`.

### P1-06 — Accessibilité et ergonomie des dialogues

Problèmes observés :

- tiroirs sans rôle `dialog`, sans `aria-modal` et sans nom programmatique ;
- pas de piège de focus, de fermeture avec Échap ni de restauration du focus ;
- boutons icône de fermeture et boutons quantité sans nom accessible ;
- recherche de stock sans label ;
- erreurs et confirmations sans région `aria-live` ou `role="alert"` ;
- états sélectionnés des catégories, paiements, périodes et types de mouvement non exposés avec `aria-pressed` ou un groupe radio ;
- lien de navigation actif sans `aria-current="page"` ;
- champs requis par la logique sans état requis ni association précise entre le champ et son erreur ;
- absence de confirmation avant une clôture sensible.

Références : `components/order-drawer.tsx:14`, `components/close-day-modal.tsx:11`, `components/cash-movement-modal.tsx:8`, `app/stock/page.tsx:6`.

L’audit des couleurs relève également plusieurs contrastes inférieurs au minimum WCAG AA pour du texte normal :

- `#718078` sur blanc : environ `4,15:1` ;
- navigation inactive : environ `3,09:1` ;
- libellé de navigation desktop : environ `2,69:1` ;
- bordures de champs sur blanc : environ `1,20:1`, sous le minimum de contraste non textuel.

Le breakpoint desktop à `700px` applique simultanément une barre de `248px`, `96px` de padding horizontal et quatre colonnes. À la largeur exacte du breakpoint, il ne reste qu’environ `356px` de contenu utile. Il faut tester et revoir cette transition, ainsi que prendre en charge `safe-area-inset-bottom` pour la navigation mobile.

Enfin, après une erreur de chargement de la clôture, le texte « Chargement du bilan… » reste affiché en même temps que l’erreur. Une valeur vide pour le prochain fond est aussi convertie en `0` sans validation métier explicite.

### P1-07 — Rendre le projet exploitable et déployable

À livrer :

- script documenté pour lancer interface, API et base ;
- URL d’API configurée par environnement ou API intégrée à Next.js ;
- migrations automatiques ;
- conteneurs ou cible de déploiement explicite ;
- healthchecks ;
- variables d’environnement non suivies par Git ;
- `.next`, caches et fichiers de build ignorés ;
- README de démarrage ;
- lint non interactif ;
- formatage ;
- tests et CI.

Le dépôt suit actuellement `.env` et de nombreux fichiers `.next`. `.gitignore` contient uniquement `node_modules`.

### P1-08 — Observabilité et audit métier

À livrer :

- logs structurés avec utilisateur, établissement et identifiant de requête ;
- suivi des échecs d’encaissement ;
- suivi des clôtures et écarts ;
- métriques de disponibilité et latence ;
- journal d’audit immuable pour prix, stocks, remboursements et caisse ;
- sauvegarde et procédure de restauration testée.

## 9. Chantiers P2 — différenciation et croissance

- multi-établissements et consolidation ;
- fournisseurs, commandes d’achat et réceptions ;
- prévision de rupture et jours de couverture ;
- recettes, ingrédients, pertes et coût matière ;
- marge brute par produit, catégorie et période ;
- objectifs et alertes configurables ;
- planning ou suivi de service si validé par le métier ;
- export comptable et intégrations ;
- mode tablette/offline si le contexte réseau l’exige ;
- abonnement, facturation, essai et gestion du cycle de vie SaaS ;
- benchmark anonymisé uniquement avec consentement et gouvernance des données.

## 10. Refonte recommandée du dashboard « Bilan »

### Le problème actuel

Le mot « Bilan » promet une lecture de gestion, mais l’écran montre surtout quatre totaux. Il ne donne ni comparaison, ni cause, ni alerte, ni action. De plus :

- la période « Aujourd’hui » représente en réalité la journée de caisse active, potentiellement au-delà de minuit ;
- le mois initial est août 2026 et les années sont codées en dur ;
- la liste des ventes et le journal sont statiques ;
- les données de paiement sont actuellement compromises par l’anomalie P0-02 ;
- aucune définition n’indique TTC/HT, fuseau horaire, fraîcheur ou statut des ventes.

### Structure MVP proposée

#### Bandeau de contexte

- établissement ;
- « Service en cours » ou période calendaire clairement nommée ;
- date/heure de dernière synchronisation ;
- état de la caisse ;
- filtre de période cohérent.

#### Bloc « À traiter maintenant »

Afficher au maximum trois à cinq actions :

- rupture ou stock sous seuil ;
- écart de caisse ;
- ticket ouvert depuis trop longtemps ;
- paiement ou mouvement anormal ;
- clôture en retard.

Chaque alerte doit mener directement à l’action.

#### Bloc performance

- chiffre d’affaires net ;
- nombre de commandes ;
- panier moyen ;
- marge brute dès que les coûts sont fiables ;
- comparaison avec la période précédente comparable ;
- comparaison avec l’objectif.

Pour un commerce, comparer un lundi à la moyenne des lundis récents est souvent plus utile que le comparer au dimanche précédent.

#### Bloc ventes

- évolution par heure pour le service ou par jour pour le mois ;
- ventes par catégorie et produit ;
- quantité, chiffre d’affaires, remise, remboursement et marge ;
- top progressions et baisses ;
- possibilité de descendre jusqu’aux commandes sources.

#### Bloc caisse

- fond initial ;
- ventes espèces ;
- entrées ;
- sorties ;
- espèces attendues ;
- espèces comptées ;
- écart ;
- détail des mouvements et auteur.

#### Bloc stock

- ruptures ;
- seuils atteints ;
- jours de couverture estimés ;
- consommation atypique ;
- valeur du stock et pertes dès que les coûts sont disponibles.

### Définitions minimales des KPI

- **Chiffre d’affaires net** : ventes complétées moins remboursements et annulations financières, selon une convention TTC/HT explicite.
- **Panier moyen** : chiffre d’affaires net divisé par le nombre de commandes encaissées non annulées.
- **Espèces attendues** : fond initial + ventes espèces + entrées - sorties - retraits.
- **Écart de caisse** : espèces comptées - espèces attendues.
- **Marge brute** : chiffre d’affaires net - coût des produits réellement consommés.
- **Taux de rupture** : références actives indisponibles / références actives, complété idéalement par la part de ventes affectées.
- **Rotation de table** : commandes terminées par table et durée moyenne entre ouverture et encaissement.

Chaque KPI doit avoir une source, une formule, un fuseau horaire et une règle de gestion testée.

## 11. Simplifications nécessaires

### Une seule architecture d’exécution clairement assumée

Le projet combine Next.js et un serveur Express séparé, sans script commun ni configuration de déploiement. Pour ce périmètre, deux options sont raisonnables :

1. intégrer les endpoints à Next.js avec des Route Handlers et une couche métier testable ;
2. conserver une API séparée, mais la traiter comme un service autonome avec scripts, validation, déploiement, CORS, observabilité et contrats.

Pour un MVP à petite équipe, l’option 1 réduit fortement la complexité opérationnelle.

### Un seul cycle de vie de commande

Le code contient :

- un encaissement direct qui crée immédiatement une commande `COMPLETED` ;
- un endpoint de finalisation d’une commande `PENDING` ;
- aucun endpoint qui crée réellement cette commande `PENDING`.

Il faut retenir un seul modèle :

`OPEN → PAID`, avec transitions explicites vers `CANCELLED` ou `REFUNDED`.

### Une seule vente directe

Conserver soit :

- une action « Vente directe » sans table ;
- soit un emplacement « Comptoir ».

Les deux parcours ne doivent pas coexister sans différence métier claire.

### Une seule mutation de stock

Les endpoints de patch produit et de patch stock se recouvrent. Les quantités devraient évoluer via un service de mouvements de stock, pas via plusieurs routes d’écriture absolue.

### Séparer clôture et ouverture

« Nouvelle journée » mélange deux opérations. Les termes recommandés sont :

- « Compter et clôturer la caisse » ;
- « Ouvrir un nouveau service ».

Une ouverture immédiate peut rester proposée après clôture, mais doit être un choix explicite.

## 12. Modèle de données cible minimal

Le modèle doit rester simple tout en garantissant la traçabilité.

### Identité et périmètre

- `organizations`
- `locations`
- `users`
- `memberships` avec rôle

### Exploitation

- `business_days` ou `register_sessions`
- `tables`
- `orders`
- `order_items`
- `payments`
- `refunds`
- `cash_movements`

### Catalogue et stock

- `categories`
- `products`
- `product_prices` si l’historique de prix est requis
- `stock_movements`
- `inventory_counts`
- `ingredients` et `recipes` dans une phase ultérieure

### Traçabilité

- `audit_events`

Règles structurantes :

- toutes les données métier portent au minimum `location_id` ;
- les montants sont stockés en unités monétaires entières ou manipulés avec une stratégie décimale explicite ;
- les paiements sont des lignes séparées, ce qui simplifie naturellement le mixte ;
- les soldes de stock et de caisse sont dérivables d’un journal ;
- une correction ne détruit pas l’historique ;
- les dates utilisent un instant avec fuseau, et l’établissement définit son fuseau métier.

## 13. Feuille de route recommandée

Les durées ci-dessous sont des ordres de grandeur, pas des engagements.

### Phase 0 — Rendre le projet reproductible

Objectif : un développeur peut lancer une base neuve et vérifier un parcours.

- consolider les migrations ;
- corriger le compose et le seed ;
- ajouter scripts et README ;
- configurer l’URL d’API ;
- retirer les artefacts et secrets du suivi Git ;
- ajouter lint, formatage et CI ;
- mettre à niveau les dépendances critiques.

Sortie de phase :

- installation neuve testée ;
- build, typecheck, lint et audit automatisés ;
- API indisponible signalée clairement.

### Phase 1 — Garantir l’intégrité de chaque vente

Objectif : un encaissement ne peut pas produire de données incohérentes.

- catalogue réel ;
- paiements cash, carte et mixte corrigés ;
- validation serveur ;
- total serveur affiché ;
- contrôle atomique du stock ;
- tests de concurrence et d’arrondi ;
- gestion stable des erreurs.

Sortie de phase :

- invariant `somme des paiements = total` ;
- invariant `stock >= 0` ;
- aucun identifiant produit local ;
- tests des parcours critiques.

### Phase 2 — Construire le vrai parcours de salle

Objectif : une table possède un ticket persistant et reprenable.

- commandes ouvertes ;
- reprise, modification et annulation ;
- libération fiable de table ;
- vente directe simplifiée ;
- clôture bloquée si des tickets restent ouverts ;
- reçu et historique.

Sortie de phase :

- aucune table occupée sans commande ouverte ;
- aucun ticket perdu à la fermeture ou au rafraîchissement.

### Phase 3 — Fiabiliser caisse et stock

Objectif : le responsable explique chaque différence.

- comptage et écart de clôture ;
- journal de caisse réel ;
- journal de stock ;
- inventaire et corrections motivées ;
- auteur de chaque opération ;
- alertes de rupture.

Sortie de phase :

- caisse attendue entièrement réconciliable ;
- stock actuel entièrement explicable par ses mouvements.

### Phase 4 — Livrer le cockpit gérant

Objectif : le bilan conduit à des décisions.

- historique réel ;
- période et comparaisons fiables ;
- alertes prioritaires ;
- ventes par produit/catégorie ;
- rapprochement de caisse ;
- stock à risque ;
- export et drill-down.

Sortie de phase :

- aucun contenu mocké ;
- chaque KPI possède définition et source ;
- chaque alerte propose une action.

### Phase 5 — Ajouter le socle SaaS

Objectif : plusieurs clients utilisent le produit sans risque de mélange.

- authentification ;
- organisations, établissements et rôles ;
- isolation et tests multi-tenant ;
- onboarding et paramètres ;
- audit, sauvegarde et observabilité ;
- facturation lorsque la valeur et le modèle tarifaire sont validés.

## 14. Backlog initial

### Fondation

- [ ] `FND-01 P0` Unifier le schéma et les migrations.
- [ ] `FND-02 P0` Rendre le démarrage base + API + web reproductible.
- [ ] `FND-03 P0` Mettre à niveau Next.js et traiter l’audit de dépendances.
- [ ] `FND-04 P0` Configurer l’URL d’API par environnement.
- [ ] `FND-05 P0` Ajouter gestion globale des erreurs et healthchecks.
- [ ] `FND-06 P1` Retirer `.env`, `.next` et les caches du suivi Git.
- [ ] `FND-07 P1` Ajouter lint non interactif, formatage, tests et CI.
- [ ] `FND-08 P1` Reformater les composants actuellement condensés sur une ligne.

### Vente et paiement

- [ ] `SALE-01 P0` Charger le catalogue réel dans la caisse.
- [ ] `SALE-02 P0` Corriger espèces, carte et mixte.
- [ ] `SALE-03 P0` Valider le total et les paiements côté serveur.
- [ ] `SALE-04 P0` Utiliser le total serveur dans l’interface.
- [ ] `SALE-05 P0` Persister le ticket ouvert.
- [ ] `SALE-06 P0` Reprendre ou annuler un ticket et libérer la table.
- [ ] `SALE-07 P1` Gérer reçus, remises, TVA et remboursements.
- [ ] `SALE-08 P1` Ajouter auteur, notes et historique.

### Caisse

- [ ] `CASH-01 P0` Intégrer entrées et sorties au calcul de clôture.
- [ ] `CASH-02 P0` Saisir les espèces comptées.
- [ ] `CASH-03 P0` Calculer et justifier l’écart.
- [ ] `CASH-04 P1` Séparer clôture et ouverture.
- [ ] `CASH-05 P1` Empêcher une clôture incohérente ou double.

### Stock

- [ ] `STK-01 P1` Remplacer l’écriture absolue par des mouvements atomiques.
- [ ] `STK-02 P1` Ajouter réception, correction, perte et inventaire.
- [ ] `STK-03 P1` Remplacer `prompt()` par un formulaire contextualisé.
- [ ] `STK-04 P1` Rendre le CTA principal réellement utile.
- [ ] `STK-05 P1` Décider produits finis ou recettes/ingrédients.
- [ ] `STK-06 P2` Ajouter coûts, marge et jours de couverture.

### Pilotage

- [ ] `BI-01 P0` Retirer les commandes et mouvements fictifs.
- [ ] `BI-02 P1` Relier historique, pagination et filtres.
- [ ] `BI-03 P1` Clarifier journée de caisse versus jour calendaire.
- [ ] `BI-04 P1` Remplacer les années codées en dur.
- [ ] `BI-05 P1` Ajouter comparaisons, objectifs et tendances.
- [ ] `BI-06 P1` Ajouter alertes actionnables et drill-down.
- [ ] `BI-07 P1` Ajouter export.

### SaaS et sécurité

- [ ] `SEC-01 P0` Ajouter authentification.
- [ ] `SEC-02 P0` Ajouter organisation, établissement et isolation.
- [ ] `SEC-03 P0` Appliquer les autorisations côté serveur.
- [ ] `SEC-04 P0` Restreindre CORS et durcir l’API.
- [ ] `SEC-05 P1` Ajouter journal d’audit.
- [ ] `SEC-06 P1` Ajouter sauvegarde, restauration et rétention.

### UX et accessibilité

- [ ] `UX-01 P0` Afficher clairement les pannes et supprimer les replis silencieux.
- [ ] `UX-02 P1` Gérer chargement, vide, erreur, succès et hors-ligne.
- [ ] `UX-03 P1` Rendre les dialogues accessibles et pilotables au clavier.
- [ ] `UX-04 P1` Nommer les boutons icône et annoncer erreurs/confirmations.
- [ ] `UX-05 P1` Confirmer les opérations irréversibles.
- [ ] `UX-06 P1` Tester mobile, tablette et desktop avec de vraies données.

## 15. Décisions métier à prendre avant de coder davantage

Ces questions ne peuvent pas être tranchées depuis le dépôt :

1. Kalloud cible-t-il uniquement les lounges à chicha ou toute petite restauration ?
2. Le premier produit commercial doit-il gérer un seul établissement ou plusieurs ?
3. Le stock doit-il suivre des produits finis ou des ingrédients/recettes ?
4. Une « journée » est-elle un jour calendaire, un service ou une session de caisse ?
5. Qui peut modifier un prix, corriger un stock, rembourser et clôturer ?
6. Quelles règles de TVA, devise et arrondi doivent s’appliquer ?
7. Le paiement mixte est-il réellement nécessaire au MVP ?
8. Faut-il fonctionner pendant une coupure Internet ? Si oui, quel niveau d’offline est acceptable ?
9. Le comptage de caisse est-il aveugle avant affichage du montant attendu ?
10. Quels objectifs le gérant suit-il : chiffre d’affaires, marge, fréquentation, rotation, coût matière ?
11. Quels exports ou outils comptables sont obligatoires ?
12. Quelle est la politique de conservation et de suppression des données ?

Recommandation : organiser une session métier courte avec un gérant et un responsable de service, puis inscrire les réponses directement dans cette section.

## 16. Définition de “terminé”

Une amélioration n’est pas terminée parce que le bouton existe.

Elle est terminée si :

- la règle métier est écrite ;
- la donnée provient de la source réelle ;
- le serveur valide les entrées et l’autorisation ;
- la transaction protège les invariants ;
- chargement, vide, erreur et succès sont traités ;
- l’action est utilisable au clavier et possède un nom accessible ;
- les montants et dates suivent une convention explicite ;
- le parcours critique est testé ;
- les logs permettent de diagnostiquer un échec ;
- la documentation de démarrage ou d’exploitation est mise à jour ;
- aucune donnée de démonstration n’est présentée comme réelle.

## 17. Vérifications techniques effectuées

- dépôt cloné depuis `https://github.com/EzkaMehdi/Kalloud.git` ;
- `pnpm install --frozen-lockfile` : réussi ;
- `pnpm build` : réussi ;
- `pnpm exec tsc --noEmit` : réussi ;
- `pnpm lint` : échec, car ESLint n’est pas configuré et la commande ouvre un assistant interactif ;
- `pnpm audit --prod` : 35 avis, dont 2 critiques et 12 élevés ;
- rendu HTTP de `/caisse` : réponse `200` ;
- démarrage API sans Postgres : le processus démarre puis s’arrête sur la première requête avec `ECONNREFUSED` ;
- Docker Desktop n’était pas actif pendant l’audit, donc le parcours complet avec une vraie base n’a pas pu être exécuté ;
- l’analyse statique confirme malgré tout qu’une base créée par le compose manquerait la migration `002-business-days.sql`.

## 18. Points positifs à conserver

- interface lisible, responsive et orientée tablette/mobile ;
- navigation volontairement courte ;
- terminologie globalement compréhensible pour un établissement ;
- calcul du prix serveur à partir des produits plutôt que confiance totale au prix client ;
- utilisation de paramètres SQL plutôt que concaténation ;
- transaction pour l’encaissement, le stock et la libération de table ;
- verrouillage des produits avant encaissement ;
- contrainte d’unicité prévue pour une journée ouverte ;
- séparation visuelle caisse, stock et pilotage.

Ces bases permettent une reconstruction progressive. Il n’est pas nécessaire de jeter l’interface ; il faut remplacer les illusions de fonctionnement par des flux persistés, testés et explicites.

## 19. Ordre de travail recommandé

1. `P0-01` migrations et démarrage reproductible ;
2. `P0-07` dépendances critiques ;
3. `P0-10` configuration réseau et démarrage complet ;
4. `P0-02` paiements ;
5. `P0-03` catalogue réel ;
6. `P0-04` tickets persistés ;
7. `P0-08` clôture et rapprochement ;
8. `P0-05` états d’erreur et suppression des mocks silencieux ;
9. `P0-06` identité, rôles et isolation avant toute ouverture à des clients ;
10. stock traçable ;
11. dashboard décisionnel fondé uniquement sur les données fiabilisées.

Le dashboard doit venir après l’intégrité des transactions : un beau graphique construit sur une ventilation de paiement fausse accélère une mauvaise décision.
