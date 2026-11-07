# Virée — GPS moto découverte (route et tout-terrain)

Appli web pour Android qui propose des **sorties moto « découverte »** plutôt que le trajet le plus court : boucles ou trajets d'un point A à un point B, avec un degré de découverte de 0 à 100 %, des pauses toutes les heures et le plein d'essence prévu sur une pause.

## Ce que fait l'appli

- **Boucle** : départ et retour depuis ta position ou une adresse tapée (les adresses récentes sont proposées en premier), durée de roulage, degré de découverte. Plus le degré est élevé, plus l'appli privilégie virages, cols, belvédères et lacs.
- **Point A → point B** : durée souhaitée et durée max. 0 % = trajet le plus rapide, 50 % = milieu entre durée souhaitée et durée max, 100 % = durée max.
- **Recherche en direct** : les parcours s'affichent au fur et à mesure (8 d'abord), avec une ligne qui indique l'étape en cours. Le bouton « Charger d'autres parcours » en ajoute de nouveaux, tous différents.
- **Votes** : pouce haut = parcours aimé (gardé dans « Mes sorties » pour le faire plus tard), pouce bas = parcours retiré de la liste (annulable) et plus jamais reproposé. Les votes et les notes apprennent tes goûts (virages, panoramas, lacs, routes tranquilles). Le résumé est dans les Réglages, avec une remise à zéro.
- **Petites routes** (réglage « Préférer les petites routes », activé par défaut, expérimental) : les itinéraires sont calculés avec le profil scooter de Valhalla, qui évite les axes principaux, avec une vitesse max de 90 km/h. L'évitement est d'autant plus fort que le degré de découverte est élevé, et les points de passage sont accrochés à de petites routes. Si ce profil échoue, l'appli repasse automatiquement au profil moto. Le détail d'un parcours affiche sa part réelle de petites routes.
- **Zéro demi-tour** : tout parcours qui revient sur ses pas (demi-tour, impasse, tronçon parcouru deux fois sur plus de 300 m) est écarté ou réparé, en retirant le point de passage fautif. Pour une boucle, jusqu'à 10 km communs au départ et au retour sont tolérés. Sous la liste, une ligne indique combien de parcours ont été calculés, retenus et écartés, et pourquoi.
- **Trajets déjà faits** : ils ne sont plus proposés. Si tout a déjà été fait, l'appli t'invite à augmenter la durée ou la découverte.
- **Pauses** (café, restaurant, belvédère, pique-nique) environ toutes les heures. Une seule pause déjeuner. **Plein** calé sur une pause avant la marge de sécurité.
- **Navigation** :
  - instructions vocales en français ;
  - carte orientée dans le sens de la marche (thème nuit automatique) ;
  - recalcul pour rejoindre le parcours ;
  - proposition de pause puis minuteur ;
  - jauge d'autonomie.
- **Fin de sortie** : note sur 5 étoiles, bilan, export GPX.
- **Mes sorties** : bilan des km et du temps de roulage, grande carte de tous tes trajets colorés selon leur note, liste des sorties (noter, revoir, refaire, GPX, supprimer), parcours aimés et historique des votes. Tout reste stocké sur le téléphone.
- **Mode simulation** (bouton « Simuler ») pour tester le guidage depuis chez soi. Les sorties simulées sont marquées et ne comptent ni dans le bilan ni comme trajets déjà faits.

## Mise en ligne sur GitHub Pages (≈ 5 minutes)

La géolocalisation n'est autorisée que sur une adresse **https**. GitHub Pages en fournit une gratuitement.

1. Sur github.com, clique sur **New repository**. Nomme-le par exemple `viree` et laisse-le **Public** (GitHub Pages gratuit l'exige).
2. Dans le dépôt vide, clique sur **uploading an existing file**. Glisse-dépose **le contenu** du dossier `viree` (les fichiers et dossiers qu'il contient, pas le dossier lui-même), puis clique sur **Commit changes**.
3. Va dans **Settings → Pages**. Sous « Build and deployment », choisis **Deploy from a branch**, branche `main`, dossier `/ (root)`, puis **Save**.
4. Après une minute, l'appli est en ligne sur `https://TON-PSEUDO.github.io/viree/`.

Pour une mise à jour, il suffit d'uploader à nouveau les fichiers modifiés.

## Installation sur le téléphone

1. Ouvre l'adresse dans **Chrome** sur Android.
2. Menu ⋮ → **Ajouter à l'écran d'accueil** (ou **Installer l'application**). L'appli s'ouvre alors en plein écran, comme une vraie appli.
3. Au premier lancement, **autorise la position**.
4. Premier test conseillé : choisis un parcours, appuie sur **Simuler** et vérifie la voix et l'affichage.

### Sur la moto

- **Garde l'écran allumé et le téléphone branché** : Chrome coupe le GPS quand l'écran s'éteint ou que l'appli passe en arrière-plan.
- Monte le volume ou utilise un intercom Bluetooth pour la voix.
- La recherche de parcours et les recalculs ont besoin de réseau. Les fonds de carte déjà affichés restent en cache.

## Mode tout-terrain

Sur l'accueil, l'interrupteur **Route / Tout-terrain** bascule l'appli en mode tout-terrain (fond de carte topographique OpenTopoMap).

- **Ton niveau** (débutant, intermédiaire, confirmé) et **le type de moto** (Réglages : trail lourd ou plus léger) fixent la difficulté maximale des pistes. Trail lourd = un cran en dessous, sauf en débutant. La difficulté vient des tags OpenStreetMap (tracktype, smoothness, surface…) ; une piste sans information est comptée comme moyenne.
- **Part de pistes visée** (10 à 90 %) : l'appli accroche les points de passage à des pistes de ton niveau et règle le moteur d'itinéraires pour les privilégier. La part réelle est affichée sur chaque parcours.
- **Légalité** (Réglages) :
  - standard = tout ce qui n'est pas interdit dans OpenStreetMap, les pistes sans information en orange ;
  - stricte = uniquement les pistes explicitement ouvertes ou sur le TET.
  Les parcours avec un tronçon interdit sont écartés. La barre verte / orange de chaque parcours le résume. **C'est indicatif** : la signalisation sur place et les arrêtés locaux priment.
- **Alternance piste / route** (Réglages, activée par défaut) : l'appli évite les longues sections lentes d'affilée (20 min par défaut, réglable) pour laisser le moteur refroidir sur des passages roulants. Le détail affiche la plus longue section de piste d'affilée, et la navigation indique la section en cours ou la distance jusqu'à la prochaine piste.
- **Durées réalistes** : le temps sur piste est recalculé selon la difficulté (de 40 km/h sur piste roulante à 10 km/h sur piste très difficile).
- **TET et traces GPX** : dans « Mes sorties », importe tes fichiers GPX (par exemple les traces du TET téléchargées sur transeurotrail.org). Ils restent sur ton téléphone. Ensuite :
  - les boucles tout-terrain empruntent des **tronçons de tes traces** autour du point de départ (badge « Sur le TET ») : le tronçon est suivi exactement, l'approche et le retour passent par d'autres routes ;
  - **Suivre** (ou **Sens inverse**) lance le guidage le long d'une trace, jusqu'à 150 km depuis le point le plus proche de ta position.

## Limites connues



- **Serveurs publics gratuits** : itinéraires Valhalla (FOSSGIS, limité à 1 requête par seconde, d'où les 20 à 30 secondes de recherche), lieux OpenStreetMap via Overpass, adresses via Photon. Ils sont prévus pour un usage perso et sans garantie de disponibilité. Pour diffuser l'appli à beaucoup de monde, il faudrait un serveur Valhalla dédié.
- **Durées** : ce sont des estimations du moteur d'itinéraires. Sur routes de montagne, ton rythme réel peut différer.
- **Note de virages** : elle est calculée à partir du tracé (degrés de virage par km). Les seuils sont à **calibrer avec tes premières sorties réelles**.
- **Pauses et stations** : elles viennent d'OpenStreetMap, sans horaires d'ouverture.
- **Pas de mode hors ligne complet** : pas encore de téléchargement à l'avance des cartes d'une zone (prévu pour le tout-terrain, avec un calque coloré des pistes).
- **Tout-terrain** : la difficulté et la légalité dépendent de la qualité des tags OpenStreetMap, souvent incomplets. La recherche tout-terrain fait plus de requêtes (analyse des voies empruntées), elle est donc plus longue qu'en mode route.
- **Mémoire locale** : sorties, votes et goûts sont dans le navigateur du téléphone. Effacer les données du site dans Chrome les supprime.
- Respecte toujours la signalisation : l'appli ne connaît ni les travaux ni les fermetures temporaires.

## Mode démo et tests (développement)

- `index.html?mock=1` : l'appli tourne sur un **monde simulé** (réseau routier artificiel, cols, lacs, cafés, stations) sans aucun serveur externe. Pratique pour essayer sur ordinateur. Les routes simulées ne correspondent pas au fond de carte réel.
- `node tests/test-planner.mjs` : test du générateur de parcours sur le monde simulé.
- `node tests/test-uturn.mjs`, `node tests/test-offroad.mjs` : détection des demi-tours ; mode tout-terrain (difficulté, légalité, alternance, boucles par le TET).
- `python3 tests/run_ui.py` : parcours complet de l'interface dans Chrome headless (nécessite Playwright).

## Organisation des fichiers

```
index.html            écrans de l'appli
css/app.css           styles (repris des maquettes)
js/app.js             logique des écrans
js/planner.js         générateur de parcours (recherche progressive, notation, goûts)
js/store.js           mémoire locale (sorties, parcours aimés, votes, goûts)
js/offroad.js         tout-terrain : difficulté, légalité, alternance piste / route
js/traces.js          traces GPX importées (TET), boucles et suivi de trace
js/stops.js           pauses et plein
js/names.js           noms de parcours
js/navigator.js       moteur de guidage (suivi GPS, annonces, recalcul)
js/services.js        accès Valhalla, Overpass, Photon
js/geo.js             outils géométriques
js/map.js             cartes Leaflet
js/sim.js             mode simulation
js/voice.js, gpx.js, format.js, settings.js
sw.js, manifest.webmanifest, icons/   installation comme appli
vendor/, fonts/       bibliothèques et polices embarquées
tests/                monde simulé et tests
```

## Crédits et licences

- Données et fonds de carte © contributeurs OpenStreetMap (ODbL). Fond topographique © OpenTopoMap (CC-BY-SA).
- Traces du TET : © Trans Euro Trail. Elles ne sont pas fournies avec l'appli : chacun les télécharge et les importe pour son usage personnel.
- Itinéraires : Valhalla, serveur public FOSSGIS e.V. Adresses : Photon (komoot).
- Leaflet (BSD-2-Clause), leaflet-rotate (GPL-3.0), polices Barlow et Barlow Condensed (SIL Open Font License). Les licences sont dans `vendor/` et `fonts/`.
