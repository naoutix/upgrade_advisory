# Pledge Fair — Upgrade Advisor

Compare la valeur en jeu (aUEC) de tes vaisseaux Star Citizen à leur prix réel
($), et trouve le meilleur upgrade possible. Application web statique,
données mises à jour automatiquement.

## Structure du dépôt

```
docs/                          Le site publié (GitHub Pages)
├── index.html                 Page unique de l'application
├── style.css                  Styles (thème sombre "cockpit")
├── app.js                     Toute la logique front-end (vanilla JS, sans build)
└── data.json                  Données générées — ne pas éditer à la main
scripts/
├── update-data.mjs            Génère docs/data.json (tourne dans la GitHub Action)
└── packages.txt               (optionnel) corrections manuelles de classification
.github/workflows/
└── update-data.yml            Action planifiée : régénère et commite data.json
old/                           Anciens prototypes Python (archivés, voir old/README.md)
```

## Le site (`docs/`)

`docs/` est l'application publique, pensée pour être servie telle quelle par
**GitHub Pages** (Settings → Pages → Source : branche `main`, dossier `/docs`).
Elle ne contient que du HTML/CSS/JS statique : `index.html` charge `data.json`
au chargement de la page (même origine, aucun problème CORS) et affiche les
résultats.

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
   *vraiment* en vente.
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
```

Un fichier optionnel `scripts/packages.txt` permet de corriger manuellement
la classification d'un vaisseau (nom de pack introuvable automatiquement,
etc.) :

```
Nom du vaisseau | Nom du pack | concierge
```
Le 2ᵉ et 3ᵉ champ sont optionnels.

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
  URLs) est échappé par `esc()` dans `app.js` avant insertion dans le DOM ;
- une Content-Security-Policy stricte dans `index.html` bloque tout script
  inline ou tiers en défense en profondeur.

## Mettre en ligne sur GitHub Pages

1. Créer un dépôt GitHub et y pousser ce projet.
2. Dans **Settings → Pages**, choisir la branche `main` et le dossier `/docs`.
3. Dans **Settings → Actions → General**, vérifier que les workflows ont la
   permission d'écriture (`Workflow permissions` → `Read and write
   permissions`) pour que l'Action puisse commiter `docs/data.json`.
4. Le site est servi à `https://<utilisateur>.github.io/<repo>/`.

## Anciens scripts Python

Les prototypes qui ont précédé ce pipeline (dont `upgrade_advisor.py`, qui a
directement inspiré `scripts/update-data.mjs`) sont archivés dans
[`old/`](old/), avec leur propre README détaillant leur usage. Ils ne font
plus partie du pipeline utilisé par le site public.
