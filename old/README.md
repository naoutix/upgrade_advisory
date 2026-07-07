# Anciens scripts Python (archives)

Ces trois scripts sont les prototypes qui ont mené au site actuel
([`docs/`](../docs/), alimenté par [`scripts/update-data.mjs`](../scripts/update-data.mjs)
— voir le [README principal](../README.md)). Ils ne tournent plus en
production : la [GitHub Action planifiée](../.github/workflows/update-data.yml)
utilise uniquement le pipeline Node.js. Ils restent ici pour l'historique et
pour qui voudrait relancer une comparaison en local sans passer par le site.

## Installation

```bash
cd old
python3 -m venv .venv && source .venv/bin/activate   # optionnel
pip install -r requirements.txt
```

## Évolution des trois scripts

1. **`extract_sc_ships.py`** — le tout premier brouillon. Fonctionne
   uniquement sur des sauvegardes locales "Affichage du code source" (Chrome
   `view-source:`) des pages UEX, extraites avec pandas. Aucune détection
   pledge/pack/Concierge : juste un rapprochement par nom entre deux tableaux.
2. **`pledge_fair.py`** — première version en ligne de commande. Récupère
   les pages UEX directement (URL ou fichier local), calcule le ratio
   aUEC/$ et sort un CSV. Toujours pas de distinction standalone/pack/Concierge.
3. **`upgrade_advisor.py`** — version aboutie, celle qui a précédé le site
   actuel. Génère une page HTML autonome (CSS/JS inclus) avec conseiller
   d'upgrade, détection pack/Concierge, tri/filtre par colonne, etc. La
   quasi-totalité de sa logique de fusion des données a été portée telle
   quelle en JavaScript dans `scripts/update-data.mjs`.

Le principal defaut qui a motivé le passage à un site statique : ces scripts
ne tournent qu'en local, à la demande — personne d'autre que la personne qui
les lance n'a des données à jour.

## `extract_sc_ships.py`

Le plus rudimentaire des trois. Prend deux fichiers HTML sauvegardés en
local (menu clic droit → "Afficher le code source de la page", pas
"Inspecter") depuis :
- `https://uexcorp.space/vehicles/home/list/in_game_sell/`
- `https://uexcorp.space/vehicles/home/list/pledge_store/`

et produit un CSV comparant prix aUEC et prix pledge par nom de vaisseau.

```bash
# Modifier les 3 constantes en bas du fichier (noms de fichiers d'entrée et
# de sortie) puis :
python3 extract_sc_ships.py
```

Nécessite `pandas` (les deux autres scripts ne l'utilisent pas).

## `pledge_fair.py`

```bash
# Récupère les pages UEX en ligne directement :
python3 pledge_fair.py [-o sortie.csv]

# Ou à partir de fichiers HTML locaux / d'autres URL :
python3 pledge_fair.py <in_game_sell.html|URL> <pledge_store.html|URL> [-o sortie.csv]
```

Sort un CSV avec les colonnes `vehicle, location, price_auec,
price_pledge_usd, auec_per_usd`. Le ratio vaut `-1` si le vaisseau n'est
vendu qu'en pledge, `0` s'il n'est vendu qu'en jeu, `-2` si aucun prix n'est
connu.

## `upgrade_advisor.py`

Le plus complet : génère un fichier HTML autonome (toutes les données et le
JS sont inlinés dedans) avec sélection de ton vaisseau actuel et conseils
d'upgrade classés par ratio aUEC/$.

```bash
python3 upgrade_advisor.py                          # tout en ligne
python3 upgrade_advisor.py in_game.html pledge.html  # fichiers locaux
python3 upgrade_advisor.py --no-storefront           # sans le catalogue RSI direct
python3 upgrade_advisor.py --no-rsi                  # sans repli outil d'upgrade RSI
python3 upgrade_advisor.py --no-ship-matrix          # sans Ship Matrix (statut concept)
python3 upgrade_advisor.py --no-concierge-wiki       # sans détection des packs Concierge
python3 upgrade_advisor.py --packages packages.txt   # classification manuelle + noms de pack
```

Ouvre ensuite `upgrade_advisor.html` (généré à la racine de `old/`, ignoré
par git) dans un navigateur. Voir le docstring en tête du fichier pour le
détail des sources utilisées et le format du fichier `--packages`.

**Note** : ce script scrape les pages HTML de uexcorp.space directement,
qui bloquent les requêtes venant d'IP de datacenter (GitHub Actions par
exemple) — c'est justement pourquoi `scripts/update-data.mjs` utilise l'API
officielle UEX (`api.uexcorp.uk`) à la place. En local, sur une IP
résidentielle, ce script fonctionne normalement.
