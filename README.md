# Virée — GPS moto découverte (V1 route)

Appli web pour Android qui propose des **sorties moto « découverte »** plutôt que le trajet le plus court : boucles ou trajets d'un point A à un point B, avec un degré de découverte de 0 à 100 %, des pauses toutes les heures et le plein d'essence prévu sur une pause.

## Ce que fait la V1

- **Boucle** : départ (GPS ou adresse), durée de roulage, degré de découverte. Plus le degré est élevé, plus l'appli privilégie les virages, les cols, les belvédères et les lacs.
- **Point A → point B** : durée souhaitée et durée max. 0 % = trajet le plus rapide, 50 % = milieu entre la durée souhaitée et la durée max, 100 % = durée max.
- **Choix parmi 2 à 4 parcours**, chacun avec un nom inventé, sa durée, son kilométrage, une note de virages sur 5 et le nombre de panoramas.
- **Pauses** (café, restaurant, belvédère, pique-nique, au choix) environ toutes les heures, au meilleur lieu à moins de 500 m du parcours. Une seule pause déjeuner, si l'heure s'y prête.
- **Plein d'essence** : à partir de l'autonomie restante saisie au départ, la station est calée sur une pause avant d'entamer la marge de sécurité. L'appli prévient si aucune station n'est repérée à temps.
- **Navigation** :
  - instructions virage par virage, avec annonces vocales en français ;
  - carte orientée dans le sens de la marche ;
  - recalcul automatique pour **rejoindre le parcours prévu** si tu t'en écartes ;
  - écran maintenu allumé ;
  - jauge d'autonomie ;
  - proposition de pause à l'approche, puis minuteur pendant la pause.
- **Fin de sortie** : distance, temps de roulage, moyenne, export GPX de la trace et du parcours.
- **Mode simulation** (bouton « Simuler ») : une fausse position roule le long du parcours pour tester le guidage depuis chez soi, en vitesse ×1, ×4 ou ×10, avec un bouton pour sortir volontairement du parcours.

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

## Limites connues (V1)

- **Serveurs publics gratuits** : itinéraires Valhalla (FOSSGIS, limité à 1 requête par seconde, d'où les 20 à 30 secondes de recherche), lieux OpenStreetMap via Overpass, adresses via Photon. Ils sont prévus pour un usage perso et sans garantie de disponibilité. Pour diffuser l'appli à beaucoup de monde, il faudrait un serveur Valhalla dédié.
- **Durées** : ce sont des estimations du moteur d'itinéraires. Sur routes de montagne, ton rythme réel peut différer.
- **Note de virages** : elle est calculée à partir du tracé (degrés de virage par km). Les seuils sont à **calibrer avec tes premières sorties réelles**.
- **Pauses et stations** : elles viennent d'OpenStreetMap, sans horaires d'ouverture.
- **Pas de mode hors ligne complet** : pas encore de téléchargement à l'avance des cartes d'une zone.
- Respecte toujours la signalisation : l'appli ne connaît ni les travaux ni les fermetures temporaires.

## Mode démo et tests (développement)

- `index.html?mock=1` : l'appli tourne sur un **monde simulé** (réseau routier artificiel, cols, lacs, cafés, stations) sans aucun serveur externe. Pratique pour essayer sur ordinateur. Les routes simulées ne correspondent pas au fond de carte réel.
- `node tests/test-planner.mjs` : test du générateur de parcours sur le monde simulé.
- `python3 tests/run_ui.py` : parcours complet de l'interface dans Chrome headless (nécessite Playwright).

## Organisation des fichiers

```
index.html            écrans de l'appli
css/app.css           styles (repris des maquettes)
js/app.js             logique des écrans
js/planner.js         générateur de parcours (candidats, notation, sélection)
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

- Données cartographiques © contributeurs OpenStreetMap (ODbL). Fonds de carte © CARTO.
- Itinéraires : Valhalla, serveur public FOSSGIS e.V. Adresses : Photon (komoot).
- Leaflet (BSD-2-Clause), leaflet-rotate (GPL-3.0), polices Barlow et Barlow Condensed (SIL Open Font License). Les licences sont dans `vendor/` et `fonts/`.
