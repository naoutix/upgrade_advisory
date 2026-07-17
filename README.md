# Pledge Fair — Upgrade Advisor

Compare la valeur en jeu (aUEC) de tes vaisseaux Star Citizen à leur prix réel
($), et trouve le meilleur upgrade possible. Application web statique,
données mises à jour automatiquement.

## Structure du dépôt

```
docs/                          Le site publié (GitHub Pages)
├── index.html                 Page unique de l'application
├── style.css                  Styles (thème sombre "cockpit")
├── app.js                     Front-end : lecture de l'UI et rendu du DOM (module ES)
├── core.js                    Logique pure du front-end (calculs, formatage, échappement)
├── core.test.mjs              Tests (node --test) de core.js, sans navigateur
└── data.json                  Données générées — ne pas éditer à la main
scripts/
├── update-data.mjs            Génère docs/data.json (tourne dans la GitHub Action)
├── update-data.test.mjs       Tests (node --test) des fonctions pures du script
├── packages.txt.example       Gabarit commenté des corrections manuelles
└── packages.txt               (optionnel, à créer) corrections manuelles de classification
.github/workflows/
├── ci.yml                     Lint + tests à chaque push / pull request
└── update-data.yml            Action planifiée : régénère et commite data.json
```

## Le site (`docs/`)

`docs/` est l'application publique, pensée pour être servie telle quelle par
**GitHub Pages** (Settings → Pages → Source : branche `main`, dossier `/docs`).
Elle ne contient que du HTML/CSS/JS statique : `index.html` charge `data.json`
au chargement de la page (même origine, aucun problème CORS) et affiche les
résultats.

Le JavaScript est scindé en deux modules ES, chargés via
`<script type="module">` (même origine, compatible avec la CSP stricte) :
`core.js` regroupe la logique pure (calcul des upgrades candidats, tri/filtre,
formatage, échappement HTML) et se teste sans navigateur ; `app.js` ne garde
que ce qui touche au DOM (lecture des cases à cocher, génération du HTML).
Voir [Tests](#tests).

`docs/data.json` est régénéré automatiquement par une GitHub Action
planifiée (`.github/workflows/update-data.yml`, une fois par jour, ou à la
demande via le bouton "Run workflow" dans l'onglet Actions du repo). Un
bandeau en haut de la page affiche la date de la dernière mise à jour.

## Mise à jour des données (`scripts/update-data.mjs`)

Script Node.js (aucune dépendance Python) qui récupère et fusionne :

1. [L'API officielle UEX 2.0](https://uexcorp.space/api/documentation/)
   (`api.uexcorp.uk`, lecture publique sans clé) — prix aUEC en jeu et prix
   pledge de référence. Les pages HTML de uexcorp.space bloquent les IP des
   runners GitHub Actions (403) ; l'API dédiée aux outils tiers n'a pas ce
   problème.
2. Le pledge store RSI lui-même (API interne non documentée) — catalogues
   réels "Standalone Ships" et "Packs", qui ont le dernier mot sur ce qui est
   _vraiment_ en vente.
3. L'outil d'upgrade RSI — repli si 2. est indisponible.
4. Le [Ship Matrix](https://robertsspaceindustries.com/ship-matrix/index)
   officiel — statut Concept / Flight Ready.
5. Le [wiki communautaire](https://starcitizen.tools) — packs réservés aux
   membres "Concierge" (invisibles dans le catalogue public, même sans
   compte).

Ces sources ne supportent pas toutes les requêtes cross-origin (CORS) depuis
un navigateur : c'est pourquoi la récupération se fait côté serveur (dans la
GitHub Action), pas directement dans le JS de la page.

Lancer manuellement :

```bash
npm install
node scripts/update-data.mjs
npm test   # toute la suite de tests (node --test, sans réseau) — voir « Tests »
```

Un fichier optionnel `scripts/packages.txt` permet de corriger manuellement
la classification d'un vaisseau (nom de pack introuvable automatiquement,
etc.). Il n'est pas versionné par défaut : copie le gabarit commenté
[`scripts/packages.txt.example`](scripts/packages.txt.example) en
`scripts/packages.txt`, complète-le, puis commite-le pour que la GitHub
Action le prenne en compte. Format, un vaisseau par ligne :

```
Nom du vaisseau | Nom du pack | concierge
```

Le 2ᵉ et 3ᵉ champ sont optionnels.

### Filet de sécurité sur le roster

Les quatre drapeaux `meta` de `data.json` (`storefrontOk`, `rsiOk`,
`shipMatrixOk`, `conciergeWikiOk`) ne surveillent que les sources
_auxiliaires_ ; l'Action les signale (run en échec) dès que l'une est en
repli. La source _principale_, UEX, n'a pas de drapeau : une réponse UEX vidée
ou tronquée passerait donc inaperçue. Le script refuse par sécurité de réécrire
`data.json` quand le roster tombe sous un plancher absolu (50 vaisseaux) ou
s'effondre de plus de moitié par rapport au fichier précédent : il sort en
échec (donc notification + commit sauté) et **préserve les données
précédentes** plutôt que de publier un catalogue quasi vide. Si la baisse est
légitime, relancer avec `--force` :

```bash
node scripts/update-data.mjs --force
```

## Tests

`npm test` lance toute la suite avec le lanceur intégré de Node
(`node --test`, aucune dépendance de test). Les trois fichiers sont découverts
automatiquement et ne font **aucun appel réseau réel** :

- [`scripts/update-data.test.mjs`](scripts/update-data.test.mjs) — logique du
  générateur : normalisation et appariement des noms, fusion des sources
  (UEX / storefront / wiki), repli RSI, parseurs purs des réponses réseau, et
  le filet de sécurité sur le roster. `update-data.mjs` n'expose ses fonctions
  à l'import que lorsqu'il n'est pas exécuté directement, donc les importer ne
  déclenche aucun `fetch`.
- [`scripts/update-data.network.test.mjs`](scripts/update-data.network.test.mjs)
  — contrat de la couche réseau : terminaison et garde-fou de la pagination du
  storefront, enchaînement des variantes RSI, validation de l'enveloppe UEX,
  et repli sur `null` quand une source est injoignable. `globalThis.fetch` est
  remplacé par un bouchon le temps du test — aucun trafic réel.
- [`docs/core.test.mjs`](docs/core.test.mjs) — logique pure du front-end
  ([`docs/core.js`](docs/core.js)) : calcul des upgrades candidats (règle CCU,
  répartition en groupes, ratios, tri/filtre) et échappement HTML. `core.js`
  ne touche jamais au DOM, d'où des tests sans jsdom ni navigateur.

La CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) rejoue
`npm run lint` puis `npm test` à chaque push et pull request. Elle est
distincte de `update-data.yml`, qui ne fait que régénérer `data.json` :
la CI valide le code, sans toucher aux données.

## Prévisualiser le site en local

Le site est purement statique : n'importe quel serveur de fichiers suffit.

```bash
python -m http.server 8000 -d docs
# puis ouvrir http://localhost:8000
```

(Ouvrir `docs/index.html` directement en `file://` ne marche pas : le
`fetch("./data.json")` est bloqué hors HTTP.)

## Sécurité

Les données affichées proviennent de sources externes — notamment le wiki
communautaire, publiquement éditable. Deux garde-fous côté front :

- tout texte issu de `data.json` (noms de vaisseaux, de packs, de terminaux,
  URLs) est échappé par `esc()` (dans `core.js`, appelé par `app.js`) avant
  insertion dans le DOM — le comportement de `esc()` est couvert par les tests ;
- une Content-Security-Policy stricte dans `index.html` bloque tout script
  inline ou tiers en défense en profondeur.

## Mettre en ligne sur GitHub Pages

1. Créer un dépôt GitHub et y pousser ce projet.
2. Dans **Settings → Pages**, choisir la branche `main` et le dossier `/docs`.
3. Dans **Settings → Actions → General**, vérifier que les workflows ont la
   permission d'écriture (`Workflow permissions` → `Read and write
permissions`) pour que l'Action puisse commiter `docs/data.json`.
4. Le site est servi à `https://<utilisateur>.github.io/<repo>/`.

## Historique

Ce pipeline Node.js a été porté d'anciens prototypes Python (dont
`upgrade_advisor.py`). Ceux-ci ont été retirés du dépôt une fois le portage
terminé ; ils restent consultables dans l'historique git si besoin.
