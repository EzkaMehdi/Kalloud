# Revue de sécurité finale (`OPS-08`)

Revue du socle critique avant pilote, sur les six axes du livrable :
authentification, autorisations, isolation, injection, exposition des erreurs
et dépendances. Acceptation : **aucun finding critique/élevé sur les parcours
P0**.

Résultat : **aucun finding critique ni élevé**. Trois findings moyens ou
faibles, tous corrigés, tous couverts par un test qui les empêche de revenir.

## Ce qui tenait déjà

**Authentification.** Mots de passe hachés en `bcrypt` (`SEC-03`). Jetons de
session : 32 octets aléatoires, stockés **hachés** (`sessions.token_hash`),
jamais en clair ; la résolution vérifie `revoked_at IS NULL AND expires_at >
now()`, plus le statut du compte *et* de l'adhésion (`SAAS-02`). Une adresse
inconnue est comparée à un haché factice, donc le temps de réponse ne trahit
pas son existence. Limitation par adresse et par IP sur les **échecs**
uniquement, ce qui évite de bloquer un poste qui travaille. Cookies
`httpOnly`, `sameSite=lax`, et `secure` en production.

**Injection.** Aucun chemin. Les cinq constructeurs de clause `where`
poussent chaque valeur dans un tableau de paramètres et n'émettent que des
`$n` ; les autres interpolations sont des constantes SQL de module ou des
indices de position. Les scripts d'exploitation qui composent un nom de base
le passent par une validation stricte (`quoteIdent`).

**Exposition des erreurs.** `apiRoute` est le seul chemin de sortie : une
erreur inattendue est journalisée intégralement côté serveur, indexée par
`requestId`, et répondue par un message générique (`P0-09`). Aucune trace
d'appel, aucun fragment SQL, aucun chemin de fichier n'atteint le client.

**Isolation.** `SEC-08` la couvre à deux paliers (intégration et HTTP), et un
contrôle statique interdit déjà à un gestionnaire de route d'interroger la
base directement.

**Dépendances.** `pnpm audit --audit-level=high` : aucune vulnérabilité
connue.

## Findings

### 1 — Historique des commandes lisible par un caissier *(moyen, corrigé)*

`GET /api/orders` n'avait aucun garde de permission. Un caissier obtenait
l'historique des commandes payées de l'établissement — montants, statuts, et
le nom de qui a encaissé chaque vente — filtrable par période et paginé.

`DEC-07` est explicite : un caissier voit sa propre session en cours, « mais
pas l'historique complet ni les KPI de gestion ». L'écran Bilan lui est
masqué et `/api/dashboard` lui répond `403` ; cet endpoint était **la seule
porte restée ouverte sur les mêmes données**. Ses endpoints frères
`/api/sales` et `/api/payments` portaient déjà `dashboard:view` — le garde
avait simplement été oublié ici.

Vérifié en conditions réelles avant correction : une vente encaissée par le
propriétaire, relue par le caissier avec son montant et l'auteur.

### 2 — Réglages de l'établissement lisibles par un caissier *(faible, corrigé)*

`GET /api/settings` n'avait aucun garde. Il expose
`cashDiscrepancyThreshold` : le montant en dessous duquel un écart de caisse
ne demande **aucun motif écrit** (`CASH-05`) — précisément le chiffre que
voudrait connaître quelqu'un qui rogne le tiroir.

Le garde retenu est `tables:manage` (propriétaire + responsable) et non
`settings:manage` (propriétaire seul) : c'est la **lecture**, et c'est déjà la
permission avec laquelle la navigation décide qui peut ouvrir l'écran de
configuration. Aucun écran destiné à un caissier n'appelle cet endpoint.

### 3 — Rédaction des journaux superficielle *(faible, corrigé)*

`lib/logger.ts` ne masquait les clés sensibles qu'au **premier niveau**.
Aucune fuite active — chaque appel journalise des scalaires — mais
`LogFields` est un `Record<string, unknown>`, et le premier
`logger.info("…", { body })` écrit par quelqu'un aurait imprimé un mot de
passe en clair, dans le module dont le contrat est précisément l'inverse
(`OPS-01`, `DEC-10`). Un garde qui tient tant que tout le monde s'en souvient
n'est pas un garde. La rédaction est désormais récursive, plafonnée en
profondeur pour qu'un objet cyclique ne fasse pas boucler une ligne de log.

## Ce qui empêche le retour

| Finding | Test |
| --- | --- |
| Historique / réglages | `tests/e2e/revue-securite.spec.ts` — le caissier reçoit `403`, **et** les endpoints que `DEC-07` lui laisse répondent toujours `200` |
| Rédaction des journaux | `tests/unit/logger-redaction.test.ts` (6 cas, dont l'objet imbriqué, les tableaux et le cycle) |
| Injection | `tests/unit/architecture.test.ts` — les interpolations SQL existantes sont énumérées ; une nouvelle fait échouer le test |
| Exposition des erreurs | `tests/e2e/revue-securite.spec.ts` — aucune réponse ne contient de chemin, de SQL ni de trace |

Le contrôle d'injection est une liste blanche à dessein : une nouvelle
interpolation ressemblerait exactement aux interpolations sûres qui
l'entourent, donc elle doit provoquer une relecture délibérée plutôt que de
passer en silence.

## Observation reportée

`lib/client/use-currency.ts` (`useCurrencyFormatter`) n'est importé nulle
part. Ce n'est pas un problème de sécurité — c'est du code mort, et cela
relève de `CLEAN-01`.

---

# Revue différentielle des parcours P1 (`OPS-08B`)

Revue des interfaces et endpoints ajoutés **après** le socle critique.
Acceptation : aucun finding critique/élevé ouvert avant pilote.

Résultat : **aucun finding**, critique, élevé ou autre. Ce qui a été trouvé
n'est pas une faille mais un **angle mort de la couverture**, et c'est lui
qui est refermé.

## L'angle mort

La spec d'isolation navigateur de `SEC-08` couvre exactement **un** endpoint
prenant un identifiant : `/api/products/[id]`. Le produit en compte
aujourd'hui **douze** — reçu, remboursement, comptages de stock, les quatre
routes de ticket, catégories, tables, équipe. Onze sont arrivés après la
signature du socle, et aucun n'avait jamais reçu la seule question qui
compte pour eux : *que se passe-t-il quand l'identifiant appartient à
quelqu'un d'autre ?*

Personne ne l'avait remarqué parce que rien ne surveillait le décompte. Un
treizième serait passé de la même façon.

## Ce que le balayage a montré

Les douze répondent **`404`**, et non `403` : un refus qui dit « vous n'avez
pas le droit d'y toucher » confirme que la ligne existe, et un identifiant se
devine facilement. « Ce n'est pas là » est la réponse honnête à quelqu'un
pour qui ce n'est effectivement pas là.

Le douzième, `GET /api/products/:id/stock-counts`, répond `200 []` — correct,
c'est une liste, et une liste vide est ce qu'un étranger possède ici. Vérifié
sérieusement plutôt que sur lecture du code : le produit de la victime porte
un vrai comptage, que sa propriétaire voit et que l'attaquant ne voit pas.
Sans cette seconde assertion, le tableau vide ne prouverait rien.

**Le locataire ne peut jamais être choisi par l'appelant.** Un `locationId`
glissé dans le corps est rejeté d'emblée (`strictObject`) ; glissé dans la
requête, il est ignoré — le décompte renvoyé est identique avec et sans lui.

**La pagination ne permet pas d'aspirer la table** : `limit=999999`,
`limit=-1` et une date malformée sont tous refusés en `400`.

## Ce qui empêche le retour

`tests/e2e/isolation-p1.spec.ts` balaie les douze, plus le choix de
locataire et les bornes de pagination. Et un contrôle statique
(`tests/unit/architecture.test.ts`) **énumère les routes prenant un
identifiant et exige que chacune soit nommée dans le balayage** : c'est le
garde de l'angle mort lui-même, pas seulement de ses conséquences. Vérifié en
ajoutant un endpoint factice — le test tombe avec la marche à suivre.
