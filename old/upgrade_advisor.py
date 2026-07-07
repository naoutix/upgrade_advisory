#!/usr/bin/env python3
"""
Upgrade Advisor — génère une application web (HTML/CSS/JS autonome) qui
conseille les upgrades de vaisseaux maximisant le ratio aUEC/$, à partir de :

  1. https://uexcorp.space/vehicles/home/list/in_game_sell/   (prix aUEC par lieu)
  2. https://uexcorp.space/vehicles/home/list/pledge_store/   (prix pledge $ —
     UEX n'étant pas toujours à jour sur ce qui est *réellement* vendu en
     standalone, sa colonne "en vente" n'est qu'un point de départ : elle est
     recoupée puis corrigée par les sources officielles RSI ci-dessous, qui
     ont le dernier mot en cas de désaccord.)
  3. [optionnel, priorité la plus haute] Le pledge store RSI lui-même, via son
     API GraphQL interne (non documentée, capturée depuis le trafic réseau du
     site) :
       - catalogue "Standalone Ships" → quels vaisseaux sont réellement
         achetables seuls en ce moment (remplace le "en vente" d'UEX).
       - catalogue "Packs" → les packs en vente et leur description, utilisée
         pour déduire automatiquement quel pack contient quel vaisseau
         (ex. détecte que le Reclaimer n'est plus vendu seul et, s'il
         apparaît dans un pack en vente, en récupère le nom).
  4. [optionnel] L'API GraphQL de l'outil d'upgrade RSI (non officielle) :
     https://robertsspaceindustries.com/pledge-store/api/upgrade/graphql
     → repli si le catalogue direct ci-dessus est indisponible : liste les
       vaisseaux vers lesquels un upgrade/achat standalone est possible,
       sans connaître le nom du pack.
  5. [optionnel] Le Ship Matrix officiel RSI :
     https://robertsspaceindustries.com/ship-matrix/index
     → statut de production ("flight-ready" / "in-concept") par vaisseau,
       utilisé en priorité sur l'icône "In Development" d'UEX pour la
       colonne Concept.
  6. [optionnel] Le wiki communautaire (non officiel RSI, mais tenu à jour
     par la communauté) :
     https://starcitizen.tools/List_of_ship_packages
     → certains packs (Industrial Pack, Legatus, Praetorian, etc.) ne sont
       visibles sur le pledge store que pour les membres "Concierge" (gros
       montant pledgé cumulé) — invisibles dans les catalogues 3. ci-dessus
       même sans compte. Le wiki liste ces packs et leur contenu, d'où la
       colonne Concierge (Oui/Non) dans la section "Vendus en pack
       uniquement".

Usage:
    python3 upgrade_advisor.py                          # tout en ligne
    python3 upgrade_advisor.py in_game.html pledge.html # fichiers locaux
    python3 upgrade_advisor.py --no-storefront           # sans le catalogue RSI direct
    python3 upgrade_advisor.py --no-rsi                  # sans repli outil d'upgrade RSI
    python3 upgrade_advisor.py --no-ship-matrix          # sans Ship Matrix (statut concept)
    python3 upgrade_advisor.py --no-concierge-wiki       # sans détection des packs Concierge
    python3 upgrade_advisor.py --packages packages.txt   # classification manuelle + noms de pack

Le fichier --packages contient un vaisseau par ligne (nom tel qu'affiché par
UEX, ex. "Aegis Reclaimer") à classer en "pack uniquement". On peut préciser
le nom du pack, et marquer un pack Concierge, après des "|" :
    Aegis Reclaimer | Industrial Pack | concierge
Sans "|", le vaisseau est marqué pack-only sans nom de pack connu. Ce fichier
sert surtout à corriger les cas où le recoupement automatique (catalogue
"Packs" RSI ou wiki des packs Concierge) ne trouve pas le bon nom, ou si
toutes les sources RSI/wiki deviennent indisponibles.

Les API RSI utilisées ne sont pas officielles/documentées (y compris le
catalogue direct, capturé depuis le trafic réseau du site) : elles peuvent
changer sans préavis. Dans ce cas le script affiche un avertissement et
bascule automatiquement sur la source suivante dans la liste ci-dessus.

Dépendances : pip install requests beautifulsoup4 lxml
"""

import argparse
import json
import re
import sys
import unicodedata
from datetime import date

import requests
from bs4 import BeautifulSoup

URL_IN_GAME = "https://uexcorp.space/vehicles/home/list/in_game_sell/"
URL_PLEDGE = "https://uexcorp.space/vehicles/home/list/pledge_store/"
URL_RSI_UPGRADE = "https://robertsspaceindustries.com/pledge-store/api/upgrade/graphql"
URL_SHIP_MATRIX = "https://robertsspaceindustries.com/ship-matrix/index"

# API GraphQL du pledge store RSI lui-même (celle que le site utilise pour
# afficher ses pages "Standalone Ships" / "Packs"). Non documentée : capturée
# depuis le trafic réseau du navigateur. Utilise des "persisted queries"
# Apollo — on rejoue le hash sha256 déjà connu du serveur, sans avoir besoin
# du texte de la requête. Si RSI change son build, le hash changera et
# l'appel échouera proprement (repli automatique sur les autres sources).
URL_STOREFRONT_GRAPHQL = "https://robertsspaceindustries.com/graphql"
HASH_STANDALONE_SHIPS = "ec372b54cbe912fff0590a28ce1db68f339a3367c8cfa48fd591ef9dc82140cb"
PRODUCT_ID_STANDALONE_SHIPS = 72
HASH_PACKS = "7c00a99d486ed837f63885c2b75122237059ee40e08c4d3012559ed1f983bce1"
PRODUCT_ID_PACKS = 270

# Les packs réservés aux membres "Concierge" (gros montant pledgé cumulé) ne
# sont pas visibles dans le catalogue public du pledge store (donc absents
# des deux catalogues ci-dessus, même en scrapant sans compte). Le wiki
# communautaire maintient une liste à jour de ces packs et de leur contenu.
URL_WIKI_BASE = "https://starcitizen.tools"
URL_WIKI_PACKAGES = URL_WIKI_BASE + "/List_of_ship_packages"

HTTP_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/126.0.0.0 Safari/537.36"),
    "Accept-Language": "en-US,en;q=0.9",
}

# Variantes de requêtes essayées sur l'endpoint d'upgrade RSI (API non
# officielle : le schéma peut évoluer, d'où plusieurs formes candidates).
# Le payload est un objet JSON simple {"query": ...} — l'endpoint refuse
# le format batch (tableau) avec un 400.
RSI_QUERY_VARIANTS = [
    # 1) forme historique des outils communautaires (filterShips)
    ("filterShips", """
query filterShips($fromFilters: [FilterConstraintValues], $toFilters: [FilterConstraintValues]) {
  to(filters: $toFilters) {
    ships { id name msrp skus { id title available price } }
  }
}""", {"fromFilters": [], "toFilters": []}),
    # 2) sans variables ni arguments
    (None, "query { to { ships { id name msrp skus { id title available price } } } }", None),
    # 3) racine 'ships' directe
    (None, "query { ships { id name msrp skus { id title available price } } }", None),
]


# ---------------------------------------------------------------------------
# Chargement / décodage HTML (fichier local, view-source, ou URL)
# ---------------------------------------------------------------------------

def is_url(source: str) -> bool:
    return source.lower().startswith(("http://", "https://"))


def load_html(source: str) -> str:
    if is_url(source):
        print(f"Téléchargement de {source} ...", file=sys.stderr)
        try:
            resp = requests.get(source, headers=HTTP_HEADERS, timeout=30)
            resp.raise_for_status()
        except requests.RequestException as exc:
            sys.exit(f"Erreur: impossible de récupérer {source!r} : {exc}")
        resp.encoding = resp.encoding or "utf-8"
        return resp.text

    with open(source, encoding="utf-8", errors="replace") as f:
        raw = f.read()
    if 'class="line-content"' in raw:  # sauvegarde "view-source:" de Chrome
        soup = BeautifulSoup(raw, "lxml")
        cells = soup.select("td.line-content")
        if cells:
            return "\n".join(td.get_text() for td in cells)
    return raw


def get_vehicle_rows(html: str, source: str):
    soup = BeautifulSoup(html, "lxml")
    table = soup.select_one("table.tbl-vehicles")
    if table is None:
        sys.exit(f"Erreur: table des vaisseaux introuvable dans {source!r}.")
    headers = []
    thead = table.find("thead")
    if thead:
        headers = [th.get_text(strip=True) for th in thead.find_all(["th", "td"])]
    tbody = table.find("tbody") or table
    return headers, [tr for tr in tbody.find_all("tr") if tr.find("td")]


def parse_number(value) -> float | None:
    if value is None:
        return None
    txt = re.sub(r"[^0-9.\-]", "", str(value))
    if txt in ("", "-", "."):
        return None
    try:
        n = float(txt)
    except ValueError:
        return None
    return n if n > 0 else None


def vehicle_key(tr) -> str | None:
    m = re.search(r"vehicle-row-(\d+)", tr.get("id", ""))
    return m.group(1) if m else None


def vehicle_name(tr) -> str:
    td = tr.find("td")
    name = (td.get("data-value") or td.get_text(" ", strip=True)) if td else ""
    return re.sub(r"\s+", " ", name).strip()


def find_col(headers, *candidates, default=None):
    low = [h.lower() for h in headers]
    for cand in candidates:
        for i, h in enumerate(low):
            if cand in h:
                return i
    return default


def norm_name(name: str) -> str:
    """Normalise un nom pour comparaison (minuscule, sans accents/ponctuation)."""
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", n.lower()).strip()


def wiki_ship_url(name: str) -> str:
    """Lien vers la fiche du vaisseau sur le wiki communautaire. Les pages y
    sont indexées par nom de modèle nu, sans le constructeur (ex. 'Aegis
    Reclaimer' -> .../Reclaimer) : le nom complet renvoie une 404 dans la
    plupart des cas (vérifié manuellement sur plusieurs vaisseaux), donc on
    retire toujours le premier mot (le constructeur, dans le format UEX)."""
    words = name.split()
    bare = " ".join(words[1:]) if len(words) > 1 else name
    return f"{URL_WIKI_BASE}/{bare.replace(' ', '_')}"


# ---------------------------------------------------------------------------
# Extraction UEX
# ---------------------------------------------------------------------------

def parse_in_game(source: str) -> dict:
    """{key -> {name, locations: [{loc, auec}]}}"""
    headers, rows = get_vehicle_rows(load_html(source), source)
    i_seller = find_col(headers, "seller", default=2)
    i_price = find_col(headers, "price uec", "uec", default=3)

    ships: dict = {}
    for tr in rows:
        tds = tr.find_all("td")
        if len(tds) <= max(i_seller, i_price):
            continue
        price = parse_number(tds[i_price].get("data-value")
                             or tds[i_price].get_text(strip=True))
        if price is None:
            continue
        loc = tds[i_seller].get("data-value") or tds[i_seller].get_text(" ", strip=True)
        key = vehicle_key(tr) or norm_name(vehicle_name(tr))
        entry = ships.setdefault(key, {"name": vehicle_name(tr), "locations": []})
        entry["locations"].append({"loc": re.sub(r"\s+", " ", loc).strip(),
                                   "auec": price})
    return ships


def cell_buyable(td) -> bool:
    """UEX marque les offres en vente d'une icône panier ('Possibly available
    for purchase'). Attention : ce drapeau ne distingue pas standalone / pack."""
    if td.find("i", class_="fa-shopping-cart") is not None:
        return True
    return "available for purchase" in (td.get("title") or "").lower()


def parse_pledge(source: str) -> list[dict]:
    """[{key, name, pledge, available, concept}] — prix Standalone (repli Warbond)."""
    headers, rows = get_vehicle_rows(load_html(source), source)
    i_std = find_col(headers, "standalone", default=4)
    i_wb = find_col(headers, "warbond", default=5)

    out = []
    for tr in rows:
        tds = tr.find_all("td")
        if len(tds) <= max(i_std, i_wb):
            continue
        std_td, wb_td = tds[i_std], tds[i_wb]
        std = parse_number(std_td.get("data-value") or std_td.get_text(strip=True))
        wb = parse_number(wb_td.get("data-value") or wb_td.get_text(strip=True))
        pledge = std if std is not None else wb
        available = ((std is not None and cell_buyable(std_td))
                     or (wb is not None and cell_buyable(wb_td)))
        concept = tr.find("td").find("i", title="In Development") is not None
        out.append({"key": vehicle_key(tr), "name": vehicle_name(tr),
                    "pledge": pledge, "available": bool(available),
                    "concept": concept})
    return out


# ---------------------------------------------------------------------------
# Vérification RSI (best-effort) : vaisseaux réellement achetables standalone/CCU
# ---------------------------------------------------------------------------

def rsi_post(query: str, variables=None, operation_name=None):
    """POST GraphQL simple. Renvoie (status_code, json|None, texte_brut)."""
    payload = {"query": query}
    if variables is not None:
        payload["variables"] = variables
    if operation_name:
        payload["operationName"] = operation_name
    resp = requests.post(URL_RSI_UPGRADE, json=payload,
                         headers={**HTTP_HEADERS,
                                  "Content-Type": "application/json"},
                         timeout=30)
    try:
        return resp.status_code, resp.json(), resp.text
    except ValueError:
        return resp.status_code, None, resp.text


def fetch_rsi_standalone() -> dict | None:
    """Interroge l'outil d'upgrade RSI. Renvoie {nom normalisé -> bool achetable}
    ou None si l'API a échoué/changé (le script continue alors sans elle)."""
    print(f"Vérification RSI ({URL_RSI_UPGRADE}) ...", file=sys.stderr)
    try:
        # sanity check minimal, comme suggéré par l'endpoint lui-même
        status, data, text = rsi_post("query { __typename }")
        if status != 200:
            print(f"Avertissement: API RSI inaccessible (HTTP {status}) : "
                  f"{text[:300]}", file=sys.stderr)
            return None

        errors = []
        for op_name, query, variables in RSI_QUERY_VARIANTS:
            status, data, text = rsi_post(query, variables, op_name)
            if data:
                if data.get("data"):
                    result = parse_rsi_response(data)
                    if result:
                        return result
                for e in data.get("errors") or []:
                    errors.append(e.get("message", str(e))[:200])
            elif status != 200:
                errors.append(f"HTTP {status}: {text[:200]}")

        print("Avertissement: aucune requête RSI n'a abouti. "
              "Erreurs GraphQL renvoyées :", file=sys.stderr)
        for e in dict.fromkeys(errors):  # dédoublonné, ordre conservé
            print(f"  - {e}", file=sys.stderr)
        print("→ Lance avec --rsi-debug pour inspecter le schéma, ou capture la "
              "réponse réseau de la page d'upgrade RSI dans un fichier et passe-le "
              "avec --rsi-json. Classification 'Package' via --packages en attendant.",
              file=sys.stderr)
        return None
    except requests.RequestException as exc:
        print(f"Avertissement: API RSI inaccessible ({exc}). "
              "Classification 'Package' basée sur --packages uniquement.",
              file=sys.stderr)
        return None


def find_ships_list(node):
    """Cherche récursivement une liste d'objets ressemblant à des vaisseaux
    (dicts avec 'name' et 'skus') n'importe où dans la réponse."""
    if isinstance(node, list):
        if node and all(isinstance(x, dict) and "name" in x and "skus" in x
                        for x in node):
            return node
        for item in node:
            found = find_ships_list(item)
            if found:
                return found
    elif isinstance(node, dict):
        for value in node.values():
            found = find_ships_list(value)
            if found:
                return found
    return None


def parse_rsi_response(data) -> dict | None:
    """Extrait {nom normalisé -> achetable} d'une réponse GraphQL RSI.
    Tolérant sur l'enveloppe ; renvoie None si la structure est méconnaissable."""
    ships = find_ships_list(data)
    if not ships:
        print("Avertissement: réponse RSI sans liste de vaisseaux reconnaissable, "
              "ignorée.", file=sys.stderr)
        return None
    result = {}
    for s in ships:
        skus = s.get("skus") or []
        buyable = any(sku.get("available") for sku in skus if isinstance(sku, dict))
        result[norm_name(str(s["name"]))] = buyable
    return result or None


def rsi_debug() -> None:
    """Introspecte le schéma de l'endpoint RSI et l'affiche, pour adapter
    les requêtes si l'API a changé."""
    print(f"Introspection de {URL_RSI_UPGRADE} ...\n")
    status, data, text = rsi_post("""
query {
  __schema {
    queryType {
      fields {
        name
        args { name type { name kind ofType { name } } }
        type { name kind ofType { name } }
      }
    }
  }
}""")
    if status != 200 or not data:
        print(f"HTTP {status} : {text[:500]}")
        return
    try:
        fields = data["data"]["__schema"]["queryType"]["fields"]
    except (KeyError, TypeError):
        print(json.dumps(data, indent=2)[:2000])
        return
    print("Champs racine de l'API :")
    type_names = []
    for f in fields:
        t = f["type"]
        tname = t.get("name") or (t.get("ofType") or {}).get("name") or t.get("kind")
        args = ", ".join(a["name"] for a in f.get("args", []))
        print(f"  - {f['name']}({args}) -> {tname}")
        if tname:
            type_names.append(tname)
    for tname in dict.fromkeys(type_names):
        status, data, _ = rsi_post(
            'query { __type(name: "%s") { fields { name type { name kind ofType { name } } } } }'
            % tname)
        try:
            sub = data["data"]["__type"]["fields"]
            print(f"\nType {tname} :")
            for f in sub:
                t = f["type"]
                sub_t = t.get("name") or (t.get("ofType") or {}).get("name") or t.get("kind")
                print(f"  - {f['name']} : {sub_t}")
        except (KeyError, TypeError):
            pass
    print("\nEnvoie cette sortie pour adapter les requêtes du script.")


def match_by_bare_name(uex_name: str, values: dict) -> object | None:
    """Cherche le vaisseau UEX ('Aegis Reclaimer') dans un dict indexé par nom
    sans constructeur ('reclaimer' -> ...), comme le renvoient l'outil
    d'upgrade RSI ou le Ship Matrix. Renvoie la valeur, ou None si inconnu."""
    n = norm_name(uex_name)
    if n in values:
        return values[n]
    words = n.split()
    for skip in (1, 2):  # constructeurs en 1 ou 2 mots (ex. Consolidated Outland)
        if len(words) > skip:
            cand = " ".join(words[skip:])
            if cand in values:
                return values[cand]
    return None


def fetch_ship_matrix() -> dict | None:
    """Interroge le Ship Matrix officiel RSI. Renvoie {nom normalisé sans
    constructeur -> concept bool} ou None si l'API a échoué/changé (le script
    continue alors avec le seul indicateur 'In Development' d'UEX)."""
    print(f"Vérification Ship Matrix ({URL_SHIP_MATRIX}) ...", file=sys.stderr)
    try:
        resp = requests.get(URL_SHIP_MATRIX,
                            headers={**HTTP_HEADERS, "Accept": "application/json"},
                            timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except (requests.RequestException, ValueError) as exc:
        print(f"Avertissement: Ship Matrix inaccessible ({exc}). "
              "Statut Concept basé sur UEX uniquement.", file=sys.stderr)
        return None

    ships = data.get("data")
    if not isinstance(ships, list) or not ships:
        print("Avertissement: réponse Ship Matrix sans liste de vaisseaux "
              "reconnaissable, ignorée.", file=sys.stderr)
        return None

    result = {}
    for s in ships:
        name = s.get("name")
        status = s.get("production_status")
        if not name or not status:
            continue
        result[norm_name(str(name))] = status.strip().lower() == "in-concept"
    return result or None


def _fetch_storefront_listing(operation_name: str, sha256: str, facet: str,
                              product_id: int, referer: str,
                              page_size: int = 100) -> list[dict]:
    """Rejoue une 'persisted query' Apollo du pledge store RSI (capturée dans
    le navigateur) pour lister les produits d'une catégorie ('facet'). Pagine
    jusqu'à récupérer tous les résultats. Lève une exception si le format a
    changé — laissé à l'appelant de basculer sur un repli."""
    resources: list[dict] = []
    page = 1
    total = None
    while total is None or len(resources) < total:
        payload = [{
            "operationName": operation_name,
            "variables": {"storeFront": "pledge", "query": {
                "page": page, "limit": page_size,
                "skus": {"filtersFromTags": {"tagIdentifiers": [], "facetIdentifiers": [facet]},
                         "products": [product_id]},
                "sort": {"field": "name", "direction": "asc"}}},
            "extensions": {"persistedQuery": {"version": 1, "sha256Hash": sha256}},
        }]
        resp = requests.post(URL_STOREFRONT_GRAPHQL, json=payload,
                             headers={**HTTP_HEADERS, "Content-Type": "application/json",
                                      "Referer": referer,
                                      "Origin": "https://robertsspaceindustries.com"},
                             timeout=30)
        resp.raise_for_status()
        listing = resp.json()[0]["data"]["store"]["listing"]
        batch = listing["resources"]
        if not batch:
            break
        resources.extend(batch)
        total = listing.get("totalCount", len(resources))
        page += 1
        if page > 20:  # garde-fou anti-boucle si totalCount est incohérent
            break
    return resources


def fetch_storefront_standalone_ships() -> dict | None:
    """Interroge directement le catalogue 'Standalone Ships' du pledge store
    RSI (la vraie page que voit un acheteur). Renvoie {nom normalisé sans
    constructeur -> {"available": bool, "price": prix $ ou None}}, ou None si
    l'appel échoue (API interne non documentée : le script bascule alors sur
    l'outil d'upgrade RSI puis sur UEX). Le prix sert de repli quand UEX
    connaît le vaisseau mais pas encore son prix (ex. un vaisseau tout juste
    ajouté au pledge store, comme l'Aurora Mk II à sa sortie)."""
    print(f"Vérification du catalogue Standalone Ships ({URL_STOREFRONT_GRAPHQL}) ...",
          file=sys.stderr)
    try:
        resources = _fetch_storefront_listing(
            "GetBrowseSkusStandaloneShipByFilter", HASH_STANDALONE_SHIPS,
            facet="extras-standalone-ships", product_id=PRODUCT_ID_STANDALONE_SHIPS,
            referer="https://robertsspaceindustries.com/store/pledge/browse/extras/standalone-ships")
    except (requests.RequestException, ValueError, KeyError, IndexError) as exc:
        print(f"Avertissement: catalogue Standalone Ships inaccessible ({exc}). "
              "Repli sur l'outil d'upgrade RSI / UEX.", file=sys.stderr)
        return None

    result = {}
    for r in resources:
        name = r.get("name")
        if not name:
            continue
        native = (r.get("nativePrice") or {}).get("amount")
        result[norm_name(str(name))] = {
            "available": bool((r.get("stock") or {}).get("available")),
            "price": native / 100 if isinstance(native, (int, float)) else None,
        }
    return result or None


def fetch_storefront_packs() -> list[dict] | None:
    """Interroge le catalogue 'Packs' du pledge store RSI. Renvoie
    [{name, excerpt}] pour chaque pack en vente, ou None si l'appel échoue.
    Le champ 'excerpt' (description marketing) est utilisé ensuite pour
    repérer quels vaisseaux connus sont mentionnés dans chaque pack."""
    print(f"Vérification des packs en vente ({URL_STOREFRONT_GRAPHQL}) ...", file=sys.stderr)
    try:
        resources = _fetch_storefront_listing(
            "GetBrowseSkusByFilter", HASH_PACKS,
            facet="extras-packs", product_id=PRODUCT_ID_PACKS,
            referer="https://robertsspaceindustries.com/store/pledge/browse/extras/packs")
    except (requests.RequestException, ValueError, KeyError, IndexError) as exc:
        print(f"Avertissement: catalogue Packs inaccessible ({exc}). "
              "Les noms de pack proviendront uniquement de --packages.", file=sys.stderr)
        return None
    return [{"name": r["name"], "excerpt": r.get("excerpt") or ""}
            for r in resources if r.get("name")]


def fetch_wiki_concierge_packs() -> list[dict] | None:
    """Récupère la liste des packs réservés aux membres 'Concierge' depuis le
    wiki communautaire (List_of_ship_packages) : ces packs n'apparaissent
    dans aucun catalogue public du pledge store, même sans compte, donc
    aucune des sources RSI directes ne peut les voir. Renvoie
    [{name, ships: [...]}] pour chaque pack dont la colonne 'Availability'
    mentionne 'Concierge', ou None si la page est inaccessible/a changé de
    structure (page non officielle, mise à jour par la communauté)."""
    print(f"Vérification des packs Concierge ({URL_WIKI_PACKAGES}) ...", file=sys.stderr)
    try:
        resp = requests.get(URL_WIKI_PACKAGES, headers=HTTP_HEADERS, timeout=30)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "lxml")
    except requests.RequestException as exc:
        print(f"Avertissement: wiki des packs inaccessible ({exc}). "
              "Les packs Concierge ne seront pas détectés automatiquement.", file=sys.stderr)
        return None

    packs = []
    for table in soup.select("table.wikitable, table.article-table"):
        rows = table.find_all("tr")
        if not rows:
            continue
        headers = [c.get_text(strip=True) for c in rows[0].find_all(["th", "td"])]
        try:
            i_name = headers.index("Name")
            i_ships = headers.index("Included ships")
            i_avail = headers.index("Availability")
        except ValueError:
            continue
        for tr in rows[1:]:
            cells = tr.find_all(["td", "th"])
            if len(cells) <= max(i_name, i_ships, i_avail):
                continue
            if "concierge" not in cells[i_avail].get_text(" ", strip=True).lower():
                continue
            name = cells[i_name].get_text(" ", strip=True)
            ships = [s.strip() for s in cells[i_ships].get_text("|", strip=True).split("|") if s.strip()]
            if name and ships:
                packs.append({"name": name, "ships": ships})
    return packs or None


def bare_name_candidates(names: list[str]) -> set[str]:
    """Ensemble de noms de vaisseaux sans constructeur ('reclaimer'), dérivés
    d'une liste de noms complets UEX ('Aegis Reclaimer'), pour repérer leur
    mention dans la description d'un pack."""
    out: set[str] = set()
    for name in names:
        n = norm_name(name)
        if len(n) >= 3:
            out.add(n)
        words = n.split()
        for skip in (1, 2):
            if len(words) > skip:
                cand = " ".join(words[skip:])
                if len(cand) >= 3:
                    out.add(cand)
    return out


def match_ships_to_packs(packs: list[dict], ship_names: set[str]) -> dict[str, dict]:
    """{nom de vaisseau sans constructeur -> {pack, concierge: False}} déduit
    en cherchant chaque nom de vaisseau connu dans la description ('excerpt')
    de chaque pack public en vente. Approche automatique complétée par
    --packages pour les cas ambigus ou les noms que le texte marketing
    n'utilise pas tel quel."""
    result: dict[str, dict] = {}
    for pack in packs:
        text = norm_name(pack["excerpt"])
        for candidate in ship_names:
            if candidate in result:
                continue
            if re.search(r'(?:^|\s)' + re.escape(candidate) + r'(?:\s|$)', text):
                result[candidate] = {"pack": pack["name"], "concierge": False}
    return result


def match_ships_to_concierge_packs(packs: list[dict]) -> dict[str, dict]:
    """{nom de vaisseau sans constructeur -> {pack, concierge: True}} à partir
    des listes de vaisseaux exactes du wiki (pas de recherche dans du texte
    libre ici, donc pas besoin de l'ensemble 'candidates'). Les packs les
    plus ciblés (peu de vaisseaux) sont traités avant les méga-packs
    fourre-tout (ex. Legatus), qui ne complètent que les vaisseaux non déjà
    couverts par un pack plus spécifique."""
    result: dict[str, dict] = {}
    for pack in sorted(packs, key=lambda p: len(p["ships"])):
        for token in pack["ships"]:
            key = norm_name(token)
            if len(key) < 3 or key in result:
                continue
            result[key] = {"pack": pack["name"], "concierge": True}
    return result


def load_packages_file(path: str) -> dict[str, dict]:
    """{nom normalisé -> {pack, concierge}} pour classer manuellement des
    vaisseaux en 'pack uniquement'. Format par ligne :
    'Nom du vaisseau' ou 'Nom du vaisseau | Nom du pack' ou
    'Nom du vaisseau | Nom du pack | concierge' (3e champ optionnel pour
    marquer un pack réservé aux membres Concierge)."""
    out: dict[str, dict] = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in line.split("|")]
            pack = parts[1] if len(parts) > 1 and parts[1] else None
            concierge = len(parts) > 2 and parts[2].lower() in ("concierge", "oui", "yes", "true", "1")
            out[norm_name(parts[0])] = {"pack": pack, "concierge": concierge}
    return out


# ---------------------------------------------------------------------------
# Fusion des données
# ---------------------------------------------------------------------------

def build_dataset(in_game_src: str, pledge_src: str,
                  storefront_standalone: dict | None, storefront_packs: list[dict] | None,
                  wiki_concierge_packs: list[dict] | None,
                  rsi: dict | None, ship_matrix: dict | None,
                  manual_packages: dict[str, dict]) -> list[dict]:
    in_game = parse_in_game(in_game_src)
    pledge = parse_pledge(pledge_src)
    in_game_by_name = {norm_name(v["name"]): v for v in in_game.values()}
    used = set()
    ships = []

    # Priorité : pack public (visible sans compte) d'abord, pack Concierge
    # (issu du wiki) seulement pour les vaisseaux non déjà couverts — être
    # dans un pack public sans condition est toujours l'info la plus utile.
    ship_to_pack: dict[str, dict] = {}
    if storefront_packs:
        candidates = bare_name_candidates([p["name"] for p in pledge])
        if ship_matrix:
            candidates |= set(ship_matrix.keys())
        ship_to_pack = match_ships_to_packs(storefront_packs, candidates)
    if wiki_concierge_packs:
        for key, val in match_ships_to_concierge_packs(wiki_concierge_packs).items():
            ship_to_pack.setdefault(key, val)

    def concept_for(name: str, uex_concept: bool) -> bool:
        if ship_matrix is None:
            return uex_concept
        really = match_by_bare_name(name, ship_matrix)
        return uex_concept if really is None else really

    for p in pledge:
        ig = in_game.get(p["key"]) or in_game_by_name.get(norm_name(p["name"]))
        locations = sorted(ig["locations"], key=lambda x: x["auec"]) if ig else []
        if ig:
            used.add(id(ig))
        best = locations[0] if locations else None

        # Le pledge store RSI lui-même tranche en priorité (c'est la source
        # que UEX peut avoir mal à jour) ; UEX ne sert de repli que si cette
        # vérification live échoue entièrement. Un vaisseau absent du
        # catalogue "Standalone Ships" (contrairement à un dict introuvable)
        # signifie qu'il n'y est réellement plus vendu seul, pas "inconnu".
        storefront_match = (match_by_bare_name(p["name"], storefront_standalone)
                            if storefront_standalone is not None else None)
        if storefront_standalone is not None:
            available = bool(storefront_match and storefront_match["available"])
        else:
            available = p["available"]

        pledge_price = p["pledge"]
        if pledge_price is None and storefront_match and storefront_match["price"] is not None:
            # UEX connaît le vaisseau mais pas encore son prix (ex. vaisseau
            # tout juste ajouté au pledge store) : on utilise le prix réel.
            pledge_price = storefront_match["price"]

        package_only = False
        pack_name = None
        pack_concierge = False
        manual_key = norm_name(p["name"])
        if manual_key in manual_packages:
            package_only = True
            pack_name = manual_packages[manual_key]["pack"]
            pack_concierge = manual_packages[manual_key]["concierge"]
            available = False
        elif not available:
            matched_pack = match_by_bare_name(p["name"], ship_to_pack) if ship_to_pack else None
            if matched_pack:
                package_only = True
                pack_name = matched_pack["pack"]
                pack_concierge = matched_pack["concierge"]
            elif storefront_standalone is None and rsi is not None and p["available"]:
                # Repli seulement si le catalogue RSI direct est indisponible :
                # sans lui on ne peut pas confirmer qu'un pack existe vraiment,
                # on se contente de l'indice "aucun SKU achetable" de l'outil
                # d'upgrade. Si le catalogue direct a répondu, l'absence de
                # correspondance dans ship_to_pack signifie simplement que ce
                # vaisseau n'est actuellement dans aucun pack en vente.
                really = match_by_bare_name(p["name"], rsi)
                if really is False:      # connu de RSI mais aucun SKU achetable
                    package_only = True  # → obtention via pack uniquement
                # None (nom non trouvé) : on garde le classement précédent

        ships.append({
            "name": p["name"],
            "pledge": pledge_price,
            "available": available,
            "packageOnly": package_only,
            "packName": pack_name,
            "packConcierge": pack_concierge,
            "concept": concept_for(p["name"], p["concept"]),
            "wikiUrl": wiki_ship_url(p["name"]),
            "auec": best["auec"] if best else None,
            "loc": best["loc"] if best else None,
            "ratio": (round(best["auec"] / pledge_price, 2)
                      if best and pledge_price else None),
        })

    for ig in in_game.values():  # vendus en jeu, absents du pledge store
        if id(ig) in used:
            continue
        locations = sorted(ig["locations"], key=lambda x: x["auec"])
        best = locations[0]
        ships.append({"name": ig["name"], "pledge": None, "available": False,
                      "packageOnly": False, "packName": None, "packConcierge": False,
                      "concept": concept_for(ig["name"], False),
                      "wikiUrl": wiki_ship_url(ig["name"]),
                      "auec": best["auec"], "loc": best["loc"], "ratio": None})

    ships.sort(key=lambda s: s["name"].lower())
    return ships


# ---------------------------------------------------------------------------
# Génération de l'application HTML
# ---------------------------------------------------------------------------

def render_app(ships: list[dict], storefront_ok: bool, rsi_ok: bool, ship_matrix_ok: bool,
               concierge_wiki_ok: bool) -> str:
    meta = {"date": date.today().isoformat(), "storefrontOk": storefront_ok,
            "rsiOk": rsi_ok, "shipMatrixOk": ship_matrix_ok,
            "conciergeWikiOk": concierge_wiki_ok}
    return (HTML_TEMPLATE
            .replace("__SHIP_DATA__", json.dumps(ships, ensure_ascii=False))
            .replace("__META__", json.dumps(meta)))


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pledge Fair — Upgrade Advisor</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0a0f14; --panel:#101922; --panel2:#0d141c; --edge:#1d2c3a;
  --ink:#c8dbe6; --dim:#5f7789; --amber:#f2a33c; --teal:#37c99e;
  --red:#e2604c; --blue:#57b3d9; --violet:#b58ae0; --focus:#f2a33c;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scrollbar-color:var(--edge) var(--bg)}
body{background:var(--bg);color:var(--ink);font:500 15px/1.45 "Rajdhani",system-ui,sans-serif;
  background-image:radial-gradient(1200px 500px at 70% -10%, #12202e 0%, transparent 60%);
  min-height:100vh;padding:24px clamp(12px,3vw,40px) 60px}
.mono{font-family:"IBM Plex Mono",monospace}
header{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;
  border-bottom:1px solid var(--edge);padding-bottom:14px;margin-bottom:22px}
header h1{font-size:clamp(20px,3vw,30px);font-weight:700;letter-spacing:.14em;text-transform:uppercase}
header h1 b{color:var(--amber)}
header .sub{color:var(--dim);font-size:13px;letter-spacing:.08em;text-transform:uppercase}
.layout{display:grid;grid-template-columns:340px 1fr;gap:22px}
@media(max-width:900px){.layout{grid-template-columns:1fr}}

.panel{background:var(--panel);border:1px solid var(--edge);position:relative;padding:16px}
.panel::before,.panel::after{content:"";position:absolute;width:14px;height:14px;border-color:var(--amber);border-style:solid}
.panel::before{top:-1px;left:-1px;border-width:2px 0 0 2px}
.panel::after{bottom:-1px;right:-1px;border-width:0 2px 2px 0}
.panel h2{font-size:13px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--dim);margin-bottom:6px}
.panel h2 .n{color:var(--amber)}
.panel .desc{color:var(--dim);font-size:12px;margin-bottom:12px;letter-spacing:.03em}

input[type=search]{width:100%;background:var(--panel2);border:1px solid var(--edge);color:var(--ink);
  font:600 15px "Rajdhani",sans-serif;padding:9px 12px;letter-spacing:.03em}
input[type=search]:focus{outline:2px solid var(--focus);outline-offset:-1px}
#shipList{margin-top:10px;max-height:44vh;overflow-y:auto;border:1px solid var(--edge)}
#shipList button{display:flex;justify-content:space-between;gap:8px;width:100%;text-align:left;
  background:none;border:0;border-bottom:1px solid var(--edge);color:var(--ink);
  font:600 14px "Rajdhani",sans-serif;padding:8px 10px;cursor:pointer}
#shipList button:last-child{border-bottom:0}
#shipList button:hover{background:#16222e}
#shipList button:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
#shipList button.sel{background:#1a2836;border-left:3px solid var(--amber);padding-left:7px}
#shipList .p{color:var(--amber)}
#shipList .empty{color:var(--dim);padding:10px;font-size:13px}

.current{margin-top:16px;border-top:1px dashed var(--edge);padding-top:14px}
.current .name{font-size:19px;font-weight:700;letter-spacing:.04em}
.current .name a,td.ship a{color:inherit;text-decoration:none;border-bottom:1px dotted var(--dim)}
.current .name a:hover,td.ship a:hover{color:var(--amber);border-color:var(--amber)}
.tags{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 10px}
.tag{font-size:11px;letter-spacing:.12em;text-transform:uppercase;padding:2px 8px;border:1px solid;white-space:nowrap}
.tag.av{color:var(--teal);border-color:var(--teal)}
.tag.na{color:var(--red);border-color:var(--red)}
.tag.cc{color:var(--blue);border-color:var(--blue)}
.tag.pk{color:var(--violet);border-color:var(--violet)}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.stat{background:var(--panel2);border:1px solid var(--edge);padding:8px 10px}
.stat .l{color:var(--dim);font-size:11px;letter-spacing:.14em;text-transform:uppercase}
.stat .v{font-size:17px;font-weight:600}
.stat .v.amber{color:var(--amber)} .stat .v.teal{color:var(--teal)}
.stat .d{color:var(--dim);font-size:11px}
.hint{color:var(--dim);font-size:13px;margin-top:12px}

.controls{display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-bottom:14px;color:var(--dim);font-size:13px;letter-spacing:.05em}
.controls label{display:flex;gap:6px;align-items:center;cursor:pointer;text-transform:uppercase}
.controls input{accent-color:var(--amber)}
.controls select{background:var(--panel2);border:1px solid var(--edge);color:var(--ink);
  font:600 13px "Rajdhani",sans-serif;padding:4px 8px}

.tblFilter{width:100%;background:var(--panel2);border:1px solid var(--edge);color:var(--ink);
  font:600 13px "Rajdhani",sans-serif;padding:6px 10px;letter-spacing:.03em;margin-bottom:8px}
.tblFilter:focus{outline:2px solid var(--focus);outline-offset:-1px}

table{width:100%;border-collapse:collapse;font-size:14px}
th{color:var(--dim);font-size:11px;letter-spacing:.14em;text-transform:uppercase;
  text-align:right;padding:6px 8px;border-bottom:1px solid var(--edge);white-space:nowrap}
th.sortable{cursor:pointer;user-select:none}
th.sortable:hover{color:var(--ink)}
th.sorted{color:var(--amber)}
th:first-child,td:first-child{text-align:left}
td{padding:7px 8px;border-bottom:1px solid #14202b;text-align:right;white-space:nowrap}
tr:hover td{background:#121e29}
td .loc{display:block;color:var(--dim);font-size:11px;letter-spacing:.03em;white-space:normal}
td.ship{font-weight:700;letter-spacing:.03em}
.pos{color:var(--teal)} .neg{color:var(--red)} .amb{color:var(--amber)} .vio{color:var(--violet)} .blu{color:var(--blue)}
.gainbar{display:inline-block;height:6px;background:var(--teal);vertical-align:middle;margin-left:6px;max-width:90px}
.section{margin-bottom:26px}
.section .none{color:var(--dim);font-size:14px;padding:10px 2px}
footer{margin-top:30px;color:var(--dim);font-size:12px;letter-spacing:.06em;line-height:1.6}
.tblwrap{overflow-x:auto}
.warn{color:var(--red)}
@media(prefers-reduced-motion:no-preference){
  .panel{animation:fadein .25s ease-out}
  @keyframes fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
}
</style>
</head>
<body>
<header>
  <h1>Pledge Fair <b>// Upgrade Advisor</b></h1>
  <span class="sub" id="metaLine"></span>
</header>

<div class="layout">
  <aside class="panel">
    <h2>1. Ton vaisseau actuel</h2>
    <input id="search" type="search" placeholder="Rechercher un vaisseau…" autocomplete="off">
    <div id="shipList" role="listbox" aria-label="Vaisseaux"></div>
    <div id="current" class="current" hidden></div>
  </aside>

  <main>
    <div class="controls panel" style="padding:12px 16px">
      <label><input type="checkbox" id="onlyBetter" checked> Ratio supérieur uniquement</label>
      <label><input type="checkbox" id="conciergeMode"> Mode Concierge</label>
      <label>Trier par
        <select id="sortBy">
          <option value="ratio">ratio absolu aUEC/$</option>
          <option value="marginal">ratio marginal de l'upgrade (aUEC/$)</option>
          <option value="cost">coût de l'upgrade</option>
          <option value="pledge">prix pledge</option>
        </select>
      </label>
    </div>

    <section class="section panel">
      <h2>2. Disponibles à l'achat (standalone / CCU) <span class="n" id="cAvail"></span></h2>
      <div class="desc">Achetables directement sur le pledge store en ce moment (vérifié sur le
      catalogue RSI lui-même, pas seulement sur UEX). Clique un en-tête pour trier.</div>
      <input type="search" class="tblFilter" id="filterAvail" placeholder="Filtrer ce tableau…" autocomplete="off">
      <div class="tblwrap" id="tblAvail"></div>
    </section>

    <section class="section panel">
      <h2>3. Vendus en pack uniquement <span class="n" id="cPack"></span></h2>
      <div class="desc">Absents du catalogue "Standalone Ships" du pledge store RSI en ce
      moment — obtenus uniquement via un pack. Le nom du pack est déduit automatiquement
      du catalogue "Packs" RSI public et, pour les packs réservés aux membres Concierge
      (invisibles sans ce statut, même sans compte), d'une liste tenue par le wiki
      communautaire — colonne "Concierge". Les packs Concierge sont masqués par défaut ;
      coche <b>Mode Concierge</b> ci-dessus pour les afficher. Complète via
      <code>--packages</code> si le recoupement automatique ne trouve rien.</div>
      <input type="search" class="tblFilter" id="filterPack" placeholder="Filtrer ce tableau…" autocomplete="off">
      <div class="tblwrap" id="tblPack"></div>
    </section>

    <section class="section panel">
      <h2>4. Indisponibles au pledge store — mais plus rentables <span class="n" id="cUnavail"></span></h2>
      <div class="desc">Prix connu mais pas en vente actuellement (reviennent parfois lors d'événements).
      Inclut aussi les vaisseaux d'un pack Concierge tant que <b>Mode Concierge</b> est décoché
      (coche-le pour les voir dans la section 3 avec le nom du pack).</div>
      <input type="search" class="tblFilter" id="filterUnavail" placeholder="Filtrer ce tableau…" autocomplete="off">
      <div class="tblwrap" id="tblUnavail"></div>
    </section>

    <section class="section panel">
      <h2>5. Non achetables en jeu <span class="n" id="cNoInGame"></span></h2>
      <div class="desc">Pledge supérieur au tien mais aucun prix aUEC en jeu (ratio incalculable) —
      concepts et vaisseaux jamais vendus en jeu.</div>
      <input type="search" class="tblFilter" id="filterNoInGame" placeholder="Filtrer ce tableau…" autocomplete="off">
      <div class="tblwrap" id="tblNoInGame"></div>
    </section>
  </main>
</div>

<footer id="footer">
  Le ratio utilise le prix d'achat en jeu le moins cher. Upgrade possible uniquement vers un
  prix pledge strictement supérieur (règle CCU). <b>Ratio absolu</b> = aUEC du vaisseau cible ÷
  son prix pledge complet (comme si tu l'achetais neuf). <b>Ratio marginal de l'upgrade</b> = aUEC
  gagnés ÷ $ réellement dépensés dans cet upgrade précis (différence avec ton vaisseau actuel) —
  souvent différent du ratio absolu car un CCU ne coûte que la différence de prix, pas le prix plein.
  Sources : uexcorp.space
  <span id="rsiNote"></span>
</footer>

<script>
const SHIPS = __SHIP_DATA__;
const META = __META__;

const fmtN = n => n.toLocaleString("fr-FR", {maximumFractionDigits: 0});
const fmtUsd = n => "$" + n.toLocaleString("en-US", {minimumFractionDigits: 0, maximumFractionDigits: 2});
const $ = id => document.getElementById(id);

const owned = SHIPS.filter(s => s.pledge != null);
let selected = null;

$("metaLine").textContent = "ratio aUEC / $ — données du " + META.date;
$("rsiNote").innerHTML =
  (META.storefrontOk
    ? " + standalone/pack vérifiés sur le vrai pledge store RSI."
    : ' <span class="warn">— catalogue RSI direct indisponible : repli sur l\'outil d\'upgrade RSI puis UEX.</span>')
  + (META.rsiOk
    ? " + repli outil d'upgrade RSI si besoin."
    : "")
  + (META.shipMatrixOk
    ? " + statut Concept via le Ship Matrix RSI."
    : ' <span class="warn">— Ship Matrix indisponible : le statut Concept repose sur UEX.</span>')
  + (META.conciergeWikiOk
    ? " + packs Concierge repérés via le wiki communautaire."
    : ' <span class="warn">— wiki des packs Concierge indisponible : ceux-ci ne sont pas détectés.</span>');

function packTag(s) {
  return `<span class="tag pk">${s.packName ? "Pack : " + s.packName : "Pack"}${s.packConcierge ? " (Concierge)" : ""}</span>`;
}

function tagsOf(s, showConcept = true) {
  const t = [];
  const hiddenConcierge = s.packageOnly && s.packConcierge && !$("conciergeMode").checked;
  if (hiddenConcierge) t.push('<span class="tag na">Pas en vente</span>');
  else if (s.packageOnly) t.push(packTag(s));
  else if (s.available) t.push('<span class="tag av">En vente</span>');
  else t.push('<span class="tag na">Pas en vente</span>');
  if (showConcept && s.concept) t.push('<span class="tag cc">Concept</span>');
  return t.join("");
}

/* ------- liste de sélection ------- */
function renderList(filter) {
  const box = $("shipList");
  box.innerHTML = "";
  const f = (filter || "").trim().toLowerCase();
  const items = owned.filter(s => s.name.toLowerCase().includes(f));
  if (!items.length) {
    box.innerHTML = '<div class="empty">Aucun vaisseau ne correspond.</div>';
    return;
  }
  for (const s of items) {
    const b = document.createElement("button");
    b.setAttribute("role", "option");
    if (selected && selected.name === s.name) b.className = "sel";
    b.innerHTML = `<span>${s.name}</span><span class="p mono">${fmtUsd(s.pledge)}</span>`;
    b.onclick = () => { selected = s; renderList($("search").value); renderCurrent(); renderTables(); };
    box.appendChild(b);
  }
}

/* ------- fiche du vaisseau sélectionné ------- */
function renderCurrent() {
  const el = $("current");
  if (!selected) { el.hidden = true; return; }
  el.hidden = false;
  const s = selected;
  el.innerHTML = `
    <div class="name"><a href="${s.wikiUrl}" target="_blank" rel="noopener">${s.name}</a></div>
    <div class="tags">${tagsOf(s)}</div>
    <div class="stats">
      <div class="stat"><div class="l">Pledge</div><div class="v amber mono">${fmtUsd(s.pledge)}</div></div>
      <div class="stat"><div class="l">Prix en jeu</div>
        <div class="v mono">${s.auec != null ? fmtN(s.auec) : "—"}</div>
        <div class="d">${s.loc || "non vendu en jeu"}</div></div>
      <div class="stat" style="grid-column:1/-1"><div class="l">Ratio actuel</div>
        <div class="v teal mono">${s.ratio != null ? fmtN(s.ratio) + " aUEC/$" : "—"}</div></div>
    </div>
    <div class="hint">Objectif : trouver un vaisseau plus cher en pledge avec un meilleur ratio.</div>`;
}

/* ------- calcul des candidats ------- */
function candidates() {
  if (!selected) return {avail: [], pack: [], unavail: [], noInGame: []};
  const base = selected;
  const onlyBetter = $("onlyBetter").checked;
  const withRatio = [], noInGame = [];
  for (const s of SHIPS) {
    if (s === base || s.pledge == null) continue;
    if (s.pledge <= base.pledge) continue;               // règle CCU
    const cost = s.pledge - base.pledge;
    if (s.ratio == null) {                                // pas de prix en jeu
      noInGame.push({...s, cost});
      continue;
    }
    if (onlyBetter && base.ratio != null && s.ratio <= base.ratio) continue;
    const marginal = base.auec != null ? (s.auec - base.auec) / cost : s.auec / cost;
    withRatio.push({...s, cost, marginal,
      gain: base.ratio != null ? (s.ratio / base.ratio - 1) * 100 : null});
  }
  const key = $("sortBy").value;
  const cmp = {
    ratio: (a, b) => b.ratio - a.ratio,
    marginal: (a, b) => b.marginal - a.marginal,
    cost: (a, b) => a.cost - b.cost,
    pledge: (a, b) => a.pledge - b.pledge,
  }[key];
  withRatio.sort(cmp);
  noInGame.sort((a, b) => a.pledge - b.pledge);
  const conciergeMode = $("conciergeMode").checked;
  return {
    avail: withRatio.filter(r => r.available && !r.packageOnly),
    pack: withRatio.filter(r => r.packageOnly && (conciergeMode || !r.packConcierge)),
    unavail: withRatio.filter(r => (!r.available && !r.packageOnly)
      || (r.packageOnly && r.packConcierge && !conciergeMode)),
    noInGame,
  };
}

/* ------- tri et filtre par tableau ------- */
const tableState = {
  avail: {sort: null, dir: 1, filter: ""},
  pack: {sort: null, dir: 1, filter: ""},
  unavail: {sort: null, dir: 1, filter: ""},
  noInGame: {sort: null, dir: 1, filter: ""},
};

function sortTable(key, col) {
  const st = tableState[key];
  if (st.sort === col) st.dir *= -1;
  else { st.sort = col; st.dir = 1; }
  renderTables();
}

function setFilter(key, value) {
  tableState[key].filter = (value || "").trim().toLowerCase();
  renderTables();
}

function applyTableState(key, rows, filterFields) {
  const st = tableState[key];
  let out = rows;
  if (st.filter) {
    out = out.filter(r => filterFields.some(f => String(r[f] ?? "").toLowerCase().includes(st.filter)));
  }
  if (st.sort) {
    const col = st.sort, dir = st.dir;
    out = [...out].sort((a, b) => {
      let va = a[col], vb = b[col];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "boolean") { va = va ? 1 : 0; vb = vb ? 1 : 0; }
      if (typeof va === "string") return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
  }
  return out;
}

function thSort(key, col, label, title = "") {
  const st = tableState[key];
  const active = st.sort === col;
  const arrow = active ? (st.dir === 1 ? " ▲" : " ▼") : "";
  const titleAttr = title ? ` title="${title}"` : "";
  return `<th class="sortable${active ? " sorted" : ""}"${titleAttr} onclick="sortTable('${key}','${col}')">${label}${arrow}</th>`;
}

/* ------- tables ------- */
function ratioTable(key, rows, opts = {}) {
  rows = applyTableState(key, rows, opts.showPack ? ["name", "packName"] : ["name"]);
  if (!rows.length) return '<div class="none">Aucun vaisseau ne remplit les critères.</div>';
  const maxRatio = Math.max(...rows.map(r => r.ratio));
  const tr = rows.map(r => `
    <tr>
      <td class="ship"><a href="${r.wikiUrl}" target="_blank" rel="noopener">${r.name}</a></td>
      <td class="${r.concept ? "blu" : "pos"}">${r.concept ? "Concept" : "Fly Ready"}</td>
      ${opts.showPack ? `<td>${packTag(r)}</td>` : ""}
      <td class="mono amb">${fmtUsd(r.pledge)}</td>
      <td class="mono">+${fmtUsd(r.cost)}</td>
      <td class="mono">${fmtN(r.auec)}<span class="loc">${r.loc}</span></td>
      <td class="mono pos">${fmtN(r.ratio)}<span class="gainbar" style="width:${(r.ratio / maxRatio * 90).toFixed(0)}px"></span></td>
      <td class="mono ${r.gain == null ? "" : r.gain >= 0 ? "pos" : "neg"}">${r.gain == null ? "—" : (r.gain >= 0 ? "+" : "") + r.gain.toFixed(0) + " %"}</td>
      <td class="mono">${fmtN(r.marginal)}</td>
    </tr>`).join("");
  return `<table>
    <thead><tr>
      ${thSort(key, "name", "Vaisseau")}${thSort(key, "concept", "Concept")}
      ${opts.showPack ? thSort(key, "packName", "Statut pledge store") : ""}
      ${thSort(key, "pledge", "Pledge")}${thSort(key, "cost", "Coût upgrade")}
      ${thSort(key, "auec", "Prix en jeu (aUEC)")}
      ${thSort(key, "ratio", "Ratio absolu (aUEC/$)", "aUEC du vaisseau cible ÷ son prix pledge complet — comme si tu l'achetais neuf")}
      ${thSort(key, "gain", "Gain ratio")}
      ${thSort(key, "marginal", "Ratio marginal de l'upgrade (aUEC/$)", "aUEC gagnés ÷ $ réellement dépensés dans CET upgrade (différence avec ton vaisseau actuel)")}
    </tr></thead><tbody>${tr}</tbody></table>`;
}

function noInGameTable(key, rows) {
  rows = applyTableState(key, rows, ["name"]);
  if (!rows.length) return '<div class="none">Aucun vaisseau ne remplit les critères.</div>';
  const tr = rows.map(r => `
    <tr>
      <td class="ship"><a href="${r.wikiUrl}" target="_blank" rel="noopener">${r.name}</a></td>
      <td class="${r.concept ? "blu" : "pos"}">${r.concept ? "Concept" : "Fly Ready"}</td>
      <td>${tagsOf(r, false)}</td>
      <td class="mono amb">${fmtUsd(r.pledge)}</td>
      <td class="mono">+${fmtUsd(r.cost)}</td>
    </tr>`).join("");
  return `<table>
    <thead><tr>
      ${thSort(key, "name", "Vaisseau")}${thSort(key, "concept", "Concept")}<th>Statut pledge store</th>
      ${thSort(key, "pledge", "Pledge")}${thSort(key, "cost", "Coût upgrade")}
    </tr></thead><tbody>${tr}</tbody></table>`;
}

function renderTables() {
  if (!selected) {
    for (const id of ["tblAvail", "tblPack", "tblUnavail", "tblNoInGame"])
      $(id).innerHTML = '<div class="none">Sélectionne d\u2019abord ton vaisseau à gauche.</div>';
    for (const id of ["cAvail", "cPack", "cUnavail", "cNoInGame"])
      $(id).textContent = "";
    return;
  }
  const c = candidates();
  $("tblAvail").innerHTML = ratioTable("avail", c.avail);
  $("tblPack").innerHTML = ratioTable("pack", c.pack, {showPack: true});
  $("tblUnavail").innerHTML = ratioTable("unavail", c.unavail);
  $("tblNoInGame").innerHTML = noInGameTable("noInGame", c.noInGame);
  $("cAvail").textContent = "· " + c.avail.length;
  $("cPack").textContent = "· " + c.pack.length;
  $("cUnavail").textContent = "· " + c.unavail.length;
  $("cNoInGame").textContent = "· " + c.noInGame.length;
}

$("search").addEventListener("input", e => renderList(e.target.value));
$("onlyBetter").addEventListener("change", renderTables);
$("sortBy").addEventListener("change", renderTables);
$("conciergeMode").addEventListener("change", () => { renderCurrent(); renderTables(); });
$("filterAvail").addEventListener("input", e => setFilter("avail", e.target.value));
$("filterPack").addEventListener("input", e => setFilter("pack", e.target.value));
$("filterUnavail").addEventListener("input", e => setFilter("unavail", e.target.value));
$("filterNoInGame").addEventListener("input", e => setFilter("noInGame", e.target.value));

renderList("");
renderTables();
</script>
</body>
</html>
"""


def main() -> None:
    ap = argparse.ArgumentParser(description="Génère l'application web Upgrade Advisor (aUEC/$) — uexcorp.space + RSI")
    ap.add_argument("in_game_html", nargs="?", default=URL_IN_GAME,
                    help=f"Fichier HTML ou URL 'Sold in-game' (défaut: {URL_IN_GAME})")
    ap.add_argument("pledge_html", nargs="?", default=URL_PLEDGE,
                    help=f"Fichier HTML ou URL 'Pledge store' (défaut: {URL_PLEDGE})")
    ap.add_argument("-o", "--output", default="upgrade_advisor.html",
                    help="Fichier HTML généré (défaut: upgrade_advisor.html)")
    ap.add_argument("--no-storefront", action="store_true",
                    help="Ne pas interroger le vrai catalogue du pledge store RSI "
                         "(Standalone Ships / Packs) — repli sur l'outil d'upgrade RSI et UEX")
    ap.add_argument("--no-rsi", action="store_true",
                    help="Ne pas interroger l'API RSI pour vérifier la dispo standalone")
    ap.add_argument("--rsi-json", metavar="FICHIER",
                    help="Réponse JSON de l'API RSI capturée dans le navigateur "
                         "(onglet Réseau), utilisée à la place de l'appel réseau")
    ap.add_argument("--rsi-debug", action="store_true",
                    help="Introspecte le schéma de l'API RSI puis quitte")
    ap.add_argument("--no-ship-matrix", action="store_true",
                    help="Ne pas interroger le Ship Matrix RSI pour le statut Concept")
    ap.add_argument("--no-concierge-wiki", action="store_true",
                    help="Ne pas interroger le wiki pour la liste des packs Concierge")
    ap.add_argument("--packages", metavar="FICHIER",
                    help="Fichier texte : vaisseaux à classer en 'pack uniquement', "
                         "avec nom de pack et statut Concierge optionnels "
                         "('Nom du vaisseau | Nom du pack | concierge')")
    args = ap.parse_args()

    if args.rsi_debug:
        rsi_debug()
        return

    if args.no_storefront:
        storefront_standalone, storefront_packs = None, None
    else:
        storefront_standalone = fetch_storefront_standalone_ships()
        storefront_packs = fetch_storefront_packs()

    wiki_concierge_packs = None if args.no_concierge_wiki else fetch_wiki_concierge_packs()

    if args.rsi_json:
        with open(args.rsi_json, encoding="utf-8") as f:
            rsi = parse_rsi_response(json.load(f))
        if rsi:
            print(f"{len(rsi)} vaisseaux chargés depuis {args.rsi_json}.",
                  file=sys.stderr)
    elif args.no_rsi:
        rsi = None
    else:
        rsi = fetch_rsi_standalone()

    ship_matrix = None if args.no_ship_matrix else fetch_ship_matrix()

    manual = load_packages_file(args.packages) if args.packages else {}

    ships = build_dataset(args.in_game_html, args.pledge_html,
                          storefront_standalone, storefront_packs, wiki_concierge_packs,
                          rsi, ship_matrix, manual)
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(render_app(ships, storefront_ok=storefront_standalone is not None,
                           rsi_ok=rsi is not None, ship_matrix_ok=ship_matrix is not None,
                           concierge_wiki_ok=wiki_concierge_packs is not None))

    n_av = sum(1 for s in ships if s["available"] and not s["packageOnly"])
    n_pk = sum(1 for s in ships if s["packageOnly"])
    n_pk_concierge = sum(1 for s in ships if s["packageOnly"] and s["packConcierge"])
    n_ratio = sum(1 for s in ships if s["ratio"] is not None)
    n_concept = sum(1 for s in ships if s["concept"])
    print(f"{args.output} généré : {len(ships)} vaisseaux — "
          f"{n_av} achetables standalone, {n_pk} en pack uniquement "
          f"(dont {n_pk_concierge} Concierge), "
          f"{n_ratio} avec ratio calculable, {n_concept} en concept.")
    print("Ouvre le fichier dans un navigateur.")


if __name__ == "__main__":
    main()
