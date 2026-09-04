# Conservation, export et suppression (`OPS-04`)

Met en œuvre la politique de [`DEC-10`](./decisions/DEC-10-conservation-sauvegarde.md) :
conservation **6 ans** des données transactionnelles, anonymisation des données
personnelles **sous 30 jours** sur demande, purge complète possible seulement en
l'absence d'obligation légale applicable.

## Le fait qui décide de tout

Dans ce schéma, **une ligne `users` ne peut pas être supprimée** dès que la
personne a fait quoi que ce soit. Sept tables la référencent en `NO ACTION` —
`orders`, `payments`, `cash_movements`, `stock_movements`, `stock_counts`,
`business_days`, `audit_events` — parce que `DEC-10` conserve les écritures six
ans et qu'aucune ne veut rien dire sans l'identité de qui l'a enregistrée.

Une demande de suppression est donc honorée par **anonymisation sur place**, pas
par suppression : la ligne et son identifiant survivent, chaque écriture reste
rattachée à un acteur stable, et la personne derrière cet identifiant cesse
d'être identifiable. C'est ce qui permet aux deux exigences de `DEC-10` d'être
vraies en même temps — « les données personnelles sont anonymisées » et « les
données nécessaires à une obligation légale sont conservées ».

## Les commandes

```bash
pnpm data:request status    -- --location 1
pnpm data:request export    -- --location 1 --out archive.json
pnpm data:request anonymize -- --user 4
pnpm data:request purge     -- --location 1 --confirm
```

Un outil en ligne de commande et non un écran : ce sont des actes rares et
irréversibles, réalisés par le responsable d'exploitation désigné (`OPS-09`), et
non par le propriétaire d'un établissement depuis une page qu'il pourrait
atteindre par mégarde.

### `status` — ce que la conservation protège encore

Compte, table par table, les écritures encore dans la fenêtre de six ans, et
annonce **à partir de quelle date** une purge complète devient possible. Un
opérateur peut ainsi répondre « le 4 septembre 2032 » à un client plutôt que
« plus tard ».

### `export` — l'export préalable

Archive JSON de tout ce que possède l'établissement : organisation, réglages,
membres, tables, catégories, classes fiscales, produits, journées, commandes,
lignes, paiements, mouvements de caisse et de stock, comptages, journal
d'audit. Volontairement des lignes brutes et non les exports CSV du cockpit
(`BI-12`) : ceux-là répondent à des questions de gestion et omettent ce dont ils
n'ont pas besoin ; celui-ci existe pour que le client garde ce que la
suppression va retirer, et une omission y serait irrattrapable.

L'archive contient des données personnelles. Elle se transmet par un canal sûr
et ne se conserve pas — le script le rappelle à chaque exécution.

### `anonymize` — la demande de suppression

Remplace le nom, l'adresse e-mail et les identifiants ; désactive le compte ;
révoque sessions et jetons de réinitialisation ; supprime les tentatives de
connexion. **Irréversible** : rien n'est conservé pour reconstituer l'original,
c'est la différence entre anonymiser et masquer.

L'adresse de remplacement (`anonymise-<id>@supprime.invalid`) satisfait l'index
d'unicité et ne peut jamais recevoir de courrier — `.invalid` est réservé par la
RFC 2606 exactement pour cela. Le mot de passe devient une valeur qui n'est le
haché de rien : aucun mot de passe ne peut plus correspondre.

L'ancienne adresse n'est **pas** écrite dans le journal d'audit. L'y consigner
conserverait l'identifiant même que la demande visait à effacer, dans une table
où rien n'a le droit de supprimer.

L'opération est auditée sur chaque établissement où la personne était membre
(`SEC-09`) : chacun garde des écritures attribuées à cet identifiant, et son
exploitant doit pouvoir expliquer pourquoi ce nom a changé.

### `purge` — la suppression complète

Refusée tant qu'une seule écriture reste dans la fenêtre de six ans. Ce refus
**est** le critère d'acceptation de ce ticket : une purge qui emporterait
discrètement les écritures comptables satisferait la demande d'un client en
violant une obligation qu'aucune des deux parties ne peut lever.

Refusée également sans `--confirm` (`DEC-10` : « sur confirmation explicite du
client »). La suppression se fait enfants d'abord, parce que ce schéma ne
cascade que dans un sens.

La purge n'est **pas** consignée dans le journal d'audit : celui-ci est rattaché
à l'établissement et vient d'être supprimé avec lui. L'archive prise avant la
purge et le compte rendu du script sont la trace.

## Ordre recommandé pour une demande client

1. `status` — savoir ce qui est possible aujourd'hui.
2. `export` — remettre l'archive au client, par un canal sûr.
3. `anonymize` sur chaque compte concerné — sous 30 jours (`DEC-10`).
4. `purge` — seulement si `status` l'autorise, et sur confirmation écrite.

Dans la quasi-totalité des cas, un établissement en activité s'arrête à
l'étape 3 : c'est le comportement attendu, pas une limitation.

## Testé

`tests/integration/retention.test.ts` (15 cas). Le plus important vérifie
qu'après anonymisation d'un caissier ayant encaissé, la vente est toujours là,
toujours attribuée, toujours jointe — total inchangé, paiements, mouvements de
stock et de caisse intacts. Vérifié par mutation : remplacer l'anonymisation par
une suppression fait tomber ce test, tout comme retirer le contrôle de
conservation avant la purge, ou consigner l'ancienne adresse dans l'audit.

## Ce qui n'est pas là

Aucune interface, aucun déclenchement automatique à J+30. `DEC-10` fixe un délai
de traitement, pas une échéance à automatiser : la demande arrive par un canal
humain et le responsable d'exploitation l'exécute. Automatiser une suppression
irréversible sur minuterie créerait un risque bien plus grand que celui qu'elle
retirerait.
