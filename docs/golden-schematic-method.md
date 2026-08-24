# Golden Schematic Method

## But

Cette méthode décrit **comment construire proprement n'importe quel schéma dans EasyEDA**. Le montage 7805 historique n'est qu'un exemple de non-régression ayant permis d'identifier les primitives fiables. Il ne doit jamais être utilisé comme recette universelle de circuit.

## Principes extraits du Golden 7805

Le fichier exemple a démontré plusieurs mécanismes réutilisables :

- rechercher plusieurs candidats plutôt que faire confiance au premier résultat ;
- valider qu'un composant trouvé correspond réellement à la fonction/valeur demandée ;
- lire les broches du symbole réellement créé ;
- tester rotation et miroir lorsqu'ils influencent le sens fonctionnel ;
- choisir l'orientation à partir des coordonnées réelles des broches ;
- placer les passifs selon la topologie, et non selon une rotation arbitraire ;
- interdire les fils diagonaux et les segments nuls ;
- utiliser des nets nommés, ports et symboles de masse explicites ;
- relire les broches après placement avant d'accepter la construction ;
- échouer explicitement si un contrôle géométrique ou électrique ne passe pas.

## Pipeline générique obligatoire

1. **Inspection** : lire le document, les références, les nets et les blocs déjà présents.
2. **Architecture fonctionnelle** : découper la demande en blocs et définir le flux avant placement.
3. **Spécification électrique** : déterminer caractéristiques et marges nécessaires avant la sélection de références.
4. **Sélection composant** : identifier des références compatibles, puis vérifier stock LCSC/JLCPCB.
5. **Validation brochage** : lire les pins EasyEDA et recouper les composants critiques avec le fabricant.
6. **Sonde d'orientation** : tester rotation/miroir si nécessaire et retenir celle qui correspond au flux fonctionnel.
7. **Placement** : entrée à gauche, traitement au centre, sortie à droite, masse vers le bas ; protections et découplages proches de leur fonction.
8. **Routage** : uniquement orthogonal, sans segment nul, fil pendant ou pseudo-connexion.
9. **Validation incrémentale** : relire chaque bloc après création.
10. **Validation finale** : relecture pin-par-pin et net-par-net, ERC/DRC si disponible, correction avant rapport.
11. **Rapport** : architecture, MPN, LCSC, stock/date, Basic/Extended si confirmé, limites non vérifiées.

## Règles de stock

La disponibilité ne choisit jamais la fonction du circuit. L'ordre est :

**besoin électrique → composants compatibles → vérification de stock → choix final.**

Une alternative n'est acceptable qu'après vérification de la fonction, tension, courant, puissance, tolérance, température, boîtier, empreinte et brochage. Une quantité non vérifiable doit être indiquée `STOCK NON VÉRIFIÉ`. Un statut JLCPCB Basic/Extended non confirmé doit être indiqué `NON VÉRIFIÉ`.

## Critère de fin

Le Copilot ne doit jamais annoncer qu'un schéma est terminé simplement parce que les composants sont visibles et que des fils ont été créés. La fin est autorisée seulement après relecture du schéma réellement créé et validation des étapes obligatoires. Toute étape non confirmée doit rester explicitement marquée `NON VÉRIFIÉ`.

## Golden 7805 comme test de non-régression

Le 7805 reste utile uniquement comme petit test déterministe permettant de vérifier que les primitives de recherche, lecture des pins, orientation, placement, routage orthogonal, nets et relecture fonctionnent toujours après une évolution du moteur. Les connaissances métier du 7805 ne doivent pas contaminer les conceptions d'autres familles de circuits.
