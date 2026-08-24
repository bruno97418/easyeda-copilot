export const SCHEMATIC_METHOD_VERSION = '1.0.0';

export function buildSchematicMethodRules() {
  return [
    'MÉTHODE GÉNÉRALE DE CONSTRUCTION DE SCHÉMA — référence structurelle Golden Schematic v1.0.',
    'Le circuit 7805 historique est uniquement un exemple de validation de cette méthode. Ne reproduis jamais sa topologie par défaut : applique les principes ci-dessous à n’importe quel circuit demandé.',

    '1. COMPRENDRE AVANT DE PLACER : inspecte le document EasyEDA réellement ouvert, les composants déjà présents, les références déjà utilisées, les nets existants et les limites de la page. Décompose ensuite la demande en blocs fonctionnels et définis le flux électrique/logique attendu avant toute création.',

    '2. SPÉCIFIER AVANT DE CHOISIR : pour chaque fonction, détermine d’abord les caractéristiques électriques nécessaires (fonction, plage de tension, courant, puissance, fréquence, tolérance, température, protections, interfaces, contraintes mécaniques). Le stock ne doit jamais dicter la fonction : il sert seulement à choisir entre des références techniquement compatibles.',

    '3. BROCHAGE RÉEL OBLIGATOIRE : n’assume jamais le brochage d’un symbole d’après son dessin, son nom ou son numéro de broche supposé. Lis les broches réelles du composant EasyEDA et, pour les composants critiques, recoupe avec la documentation fabricant. Vérifie le rôle de chaque pin avant câblage.',

    '4. ORIENTATION PAR SONDE : avant placement définitif d’un symbole dont l’orientation importe, teste si nécessaire rotation 0/90/180/270 et miroir, relis les coordonnées réelles de ses broches, puis choisis l’orientation qui respecte le flux fonctionnel. Pour les passifs, sélectionne l’orientation adaptée à la topologie au lieu d’utiliser une rotation arbitraire.',

    '5. PLACEMENT TOPOLOGIQUE : organise le schéma par fonctions et par flux, généralement entrée à gauche, traitement/conversion au centre, sortie à droite, masses vers le bas, alimentations clairement identifiées. Place protections près des entrées, découplages près des broches qu’ils protègent/alimentent, composants de boucle près du circuit concerné et connecteurs aux frontières fonctionnelles.',

    '6. LISIBILITÉ PROFESSIONNELLE : évite les composants superposés, les textes illisibles, les fils traversant les symboles, les croisements inutiles et les longs détours. Aligne les blocs, garde des espacements réguliers et utilise des labels/ports explicites lorsque cela rend le schéma plus clair que de longues liaisons.',

    '7. ROUTAGE ORTHOGONAL : privilégie exclusivement des segments horizontaux/verticaux pour les fils de schéma. Refuse les diagonales, segments de longueur nulle, boucles accidentelles, fils qui terminent dans le vide ou pseudo-connexions qui ne touchent pas réellement une broche. Chaque net créé doit avoir une intention fonctionnelle claire.',

    '8. NETS SÉMANTIQUES : nomme les réseaux importants selon leur rôle (VIN, +5V, GND, CANH, CANL, SW, FB, etc.). Ne considère jamais que deux points sont correctement reliés uniquement parce qu’ils semblent se toucher visuellement : vérifie le réseau réel et les broches membres.',

    '9. CONSTRUCTION INCRÉMENTALE : crée un bloc fonctionnel à la fois. Après chaque bloc important, relis les composants et connexions réellement créés avant de poursuivre. En cas de reprise après coupure, inspecte d’abord l’existant et continue sans dupliquer les références, composants ou nets.',

    '10. STOCK APRÈS VALIDATION TECHNIQUE : avant placement définitif, vérifie la disponibilité actuelle LCSC/JLCPCB lorsque possible. N’invente jamais une quantité. Si le stock exact n’est pas vérifiable, indique STOCK NON VÉRIFIÉ. Si une référence est indisponible, recherche une alternative seulement après avoir vérifié fonction, tension, courant, puissance, tolérance, température, boîtier, empreinte et brochage.',

    '11. QUALITÉ D’ASSEMBLAGE : privilégie à caractéristiques équivalentes les références JLCPCB Basic/standard, les stocks élevés, les empreintes courantes et les composants faciles à assembler. Le statut Basic/Extended doit être marqué NON VÉRIFIÉ s’il n’est pas confirmé par une source fiable.',

    '12. VALIDATION ÉLECTRIQUE : après câblage, relis chaque composant critique pin par pin et chaque net important. Vérifie la chaîne fonctionnelle complète, les alimentations, masses, entrées/sorties, broches enable/reset/feedback/switching, polarités, protections et valeurs nécessaires. Utilise ERC/DRC ou les outils de vérification EasyEDA disponibles quand ils sont pertinents.',

    '13. CORRECTION AVANT RAPPORT : toute anomalie trouvée pendant la relecture doit être corrigée dans EasyEDA avant de déclarer le travail terminé, sauf si la correction nécessite une décision utilisateur réellement ambiguë.',

    '14. PORTE DE SORTIE : n’écris jamais “terminé”, “validé” ou équivalent si une étape obligatoire n’a pas été réellement vérifiée. Indique explicitement les points NON VÉRIFIÉS. Un schéma n’est terminé que si placement, brochage, connexions, valeurs critiques et cohérence fonctionnelle ont été relus après création.',

    '15. RAPPORT FINAL : résume l’architecture réellement créée, liste les références fabricant et LCSC retenues, leur stock vérifié et la date de vérification, signale Basic/Extended quand confirmé, puis liste clairement toute limite ou vérification restante.',
  ];
}
