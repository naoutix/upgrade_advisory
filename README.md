# Pledge Fair — Upgrade Advisor

Compare la valeur en jeu (aUEC) de tes vaisseaux Star Citizen à leur prix réel
($), et trouve le meilleur upgrade possible. Application web statique,
données mises à jour automatiquement.

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

## Mettre en ligne sur GitHub Pages

1. Créer un dépôt GitHub et y pousser ce projet.
2. Dans **Settings → Pages**, choisir la branche `main` et le dossier `/docs`.
3. Dans **Settings → Actions → General**, vérifier que les workflows ont la
   permission d'écriture (`Workflow permissions` → `Read and write
   permissions`) pour que l'Action puisse commiter `docs/data.json`.
4. Le site est servi à `https://<utilisateur>.github.io/<repo>/`.

## Ancien outil (Python, `upgrade_advisor.py`)

Le script Python d'origine reste dans le dépôt (génère un unique fichier
HTML autonome, utile pour un usage local ponctuel) mais n'est plus le
pipeline utilisé par le site public — `scripts/update-data.mjs` l'a
remplacé pour permettre l'hébergement statique sur GitHub Pages.
