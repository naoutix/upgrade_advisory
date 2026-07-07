#!/usr/bin/env python3
"""
Pledge Fair — compare le prix aUEC en jeu au prix pledge ($) des vaisseaux
à partir des pages de uexcorp.space :
  - https://uexcorp.space/vehicles/home/list/in_game_sell/  (prix aUEC par lieu de vente)
  - https://uexcorp.space/vehicles/home/list/pledge_store/  (prix pledge en $, colonne "Standalone")

Usage:
    # Récupère directement les pages en ligne (par défaut) :
    python3 pledge_fair.py [-o sortie.csv]

    # Ou à partir de fichiers HTML locaux / d'autres URLs :
    python3 pledge_fair.py <in_game_sell.html|URL> <pledge_store.html|URL> [-o sortie.csv]

Le script accepte le HTML brut de la page ainsi que les fichiers
sauvegardés depuis "view-source:" de Chrome (il les décode automatiquement).

Dépendances : pip install requests beautifulsoup4 lxml

Colonnes de sortie :
    vehicle, location, price_auec, price_pledge_usd, auec_per_usd

Règles pour aUEC/$ :
    - prix en jeu ET prix pledge  -> price_auec / price_pledge_usd
    - prix pledge sans prix en jeu -> -1
    - prix en jeu sans prix pledge ->  0
    - aucun des deux               -> -2
"""

import argparse
import csv
import re
import sys

import requests
from bs4 import BeautifulSoup

URL_IN_GAME = "https://uexcorp.space/vehicles/home/list/in_game_sell/"
URL_PLEDGE = "https://uexcorp.space/vehicles/home/list/pledge_store/"

# User-Agent de navigateur classique pour éviter un éventuel blocage des
# clients "python-requests" par le site.
HTTP_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/126.0.0.0 Safari/537.36"),
    "Accept-Language": "en-US,en;q=0.9",
}


# ---------------------------------------------------------------------------
# Décodage / parsing générique
# ---------------------------------------------------------------------------

def is_url(source: str) -> bool:
    return source.lower().startswith(("http://", "https://"))


def fetch_url(url: str) -> str:
    """Télécharge une page HTML depuis uexcorp.space."""
    print(f"Téléchargement de {url} ...", file=sys.stderr)
    try:
        resp = requests.get(url, headers=HTTP_HEADERS, timeout=30)
        resp.raise_for_status()
    except requests.RequestException as exc:
        sys.exit(f"Erreur: impossible de récupérer {url!r} : {exc}")
    resp.encoding = resp.encoding or "utf-8"
    return resp.text


def load_html(source: str) -> str:
    """Charge le HTML depuis une URL ou un fichier local.

    Pour les fichiers : si c'est une sauvegarde 'view-source:' de Chrome
    (le HTML réel est échappé dans des cellules <td class="line-content">),
    on le décode pour retrouver le HTML d'origine. Sinon contenu tel quel.
    """
    if is_url(source):
        return fetch_url(source)

    with open(source, encoding="utf-8", errors="replace") as f:
        raw = f.read()

    if 'class="line-content"' in raw:
        soup = BeautifulSoup(raw, "lxml")
        cells = soup.select("td.line-content")
        if cells:
            return "\n".join(td.get_text() for td in cells)
    return raw


def get_vehicle_table(html: str, path: str):
    """Renvoie (thead_headers, tbody_rows) de la table des vaisseaux."""
    soup = BeautifulSoup(html, "lxml")
    table = soup.select_one("table.tbl-vehicles")
    if table is None:
        sys.exit(f"Erreur: table des vaisseaux introuvable dans {path!r} "
                 "(classe 'tbl-vehicles' absente).")

    headers = []
    thead = table.find("thead")
    if thead:
        headers = [th.get_text(strip=True) for th in thead.find_all(["th", "td"])]

    tbody = table.find("tbody") or table
    rows = [tr for tr in tbody.find_all("tr") if tr.find("td")]
    return headers, rows


def parse_number(value) -> float | None:
    """'65,356,200' -> 65356200.0 ; '$3,000.00' -> 3000.0 ; vide -> None."""
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
    """Clé d'appariement : l'id UEX du vaisseau (id='vehicle-row-123')."""
    row_id = tr.get("id", "")
    m = re.search(r"vehicle-row-(\d+)", row_id)
    return m.group(1) if m else None


def vehicle_name(tr) -> str:
    td = tr.find("td")
    if td is None:
        return ""
    name = td.get("data-value") or td.get_text(" ", strip=True)
    return re.sub(r"\s+", " ", name).strip()


def find_col(headers: list[str], *candidates: str, default: int | None = None) -> int | None:
    """Trouve l'index d'une colonne par son intitulé (insensible à la casse)."""
    low = [h.lower() for h in headers]
    for cand in candidates:
        for i, h in enumerate(low):
            if cand in h:
                return i
    return default


# ---------------------------------------------------------------------------
# Extraction des deux listes
# ---------------------------------------------------------------------------

def parse_in_game(path: str) -> list[dict]:
    """Liste de {key, name, location, price_auec} — une entrée par lieu de vente."""
    headers, rows = get_vehicle_table(load_html(path), path)
    i_seller = find_col(headers, "seller", default=2)
    i_price = find_col(headers, "price uec", "uec", default=3)

    out = []
    for tr in rows:
        tds = tr.find_all("td")
        if len(tds) <= max(i_seller, i_price):
            continue
        seller_td, price_td = tds[i_seller], tds[i_price]
        location = seller_td.get("data-value") or seller_td.get_text(" ", strip=True)
        out.append({
            "key": vehicle_key(tr),
            "name": vehicle_name(tr),
            "location": re.sub(r"\s+", " ", location).strip(),
            "price_auec": parse_number(price_td.get("data-value")
                                       or price_td.get_text(strip=True)),
        })
    return out


def parse_pledge(path: str) -> list[dict]:
    """Liste de {key, name, price_pledge} — prix 'Standalone' en $."""
    headers, rows = get_vehicle_table(load_html(path), path)
    i_price = find_col(headers, "standalone", default=4)

    out = []
    for tr in rows:
        tds = tr.find_all("td")
        if len(tds) <= i_price:
            continue
        price_td = tds[i_price]
        out.append({
            "key": vehicle_key(tr),
            "name": vehicle_name(tr),
            "price_pledge": parse_number(price_td.get("data-value")
                                         or price_td.get_text(strip=True)),
        })
    return out


# ---------------------------------------------------------------------------
# Fusion + calcul du ratio
# ---------------------------------------------------------------------------

def compute_ratio(auec: float | None, pledge: float | None) -> float:
    if auec is not None and pledge is not None:
        return round(auec / pledge, 2)
    if auec is None and pledge is not None:
        return -1.0   # pledge seulement (pas achetable en jeu)
    if auec is not None and pledge is None:
        return 0.0    # en jeu seulement (pas de prix pledge)
    return -2.0       # aucun prix


def build_rows(in_game: list[dict], pledge: list[dict]) -> list[dict]:
    # Index des prix pledge par id de vaisseau, puis par nom (repli)
    pledge_by_key = {p["key"]: p for p in pledge if p["key"]}
    pledge_by_name = {p["name"].lower(): p for p in pledge if p["name"]}

    rows = []
    matched = set()

    # 1) une ligne par (vaisseau, lieu de vente en jeu)
    for entry in in_game:
        p = pledge_by_key.get(entry["key"]) or pledge_by_name.get(entry["name"].lower())
        pledge_price = p["price_pledge"] if p else None
        if p:
            matched.add(id(p))
        auec = entry["price_auec"]
        rows.append({
            "vehicle": entry["name"],
            "location": entry["location"],
            "price_auec": auec if auec is not None else 0,
            "price_pledge_usd": pledge_price if pledge_price is not None else 0,
            "auec_per_usd": compute_ratio(auec, pledge_price),
        })

    # 2) vaisseaux du pledge store jamais vendus en jeu
    for p in pledge:
        if id(p) in matched:
            continue
        rows.append({
            "vehicle": p["name"],
            "location": "",
            "price_auec": 0,
            "price_pledge_usd": p["price_pledge"] if p["price_pledge"] is not None else 0,
            "auec_per_usd": compute_ratio(None, p["price_pledge"]),
        })

    rows.sort(key=lambda r: (r["vehicle"].lower(), r["location"].lower()))
    return rows


# ---------------------------------------------------------------------------
# Sortie
# ---------------------------------------------------------------------------

FIELDS = ["vehicle", "location", "price_auec", "price_pledge_usd", "auec_per_usd"]


def write_csv(rows: list[dict], path: str) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def print_table(rows: list[dict]) -> None:
    widths = {f: max(len(f), *(len(str(r[f])) for r in rows)) for f in FIELDS}
    line = "  ".join(f.ljust(widths[f]) for f in FIELDS)
    print(line)
    print("-" * len(line))
    for r in rows:
        print("  ".join(str(r[f]).ljust(widths[f]) for f in FIELDS))


def main() -> None:
    ap = argparse.ArgumentParser(description="Compare prix aUEC en jeu vs prix pledge ($) — uexcorp.space")
    ap.add_argument("in_game_html", nargs="?", default=URL_IN_GAME,
                    help=f"Fichier HTML ou URL de la page 'Sold in-game' (défaut: {URL_IN_GAME})")
    ap.add_argument("pledge_html", nargs="?", default=URL_PLEDGE,
                    help=f"Fichier HTML ou URL de la page 'Pledge store' (défaut: {URL_PLEDGE})")
    ap.add_argument("-o", "--output", default="pledge_fair.csv", help="Fichier CSV de sortie (défaut: pledge_fair.csv)")
    ap.add_argument("-q", "--quiet", action="store_true", help="Ne pas afficher le tableau à l'écran")
    args = ap.parse_args()

    in_game = parse_in_game(args.in_game_html)
    pledge = parse_pledge(args.pledge_html)
    rows = build_rows(in_game, pledge)

    if not args.quiet:
        print_table(rows)

    write_csv(rows, args.output)
    n_both = sum(1 for r in rows if r["auec_per_usd"] > 0)
    n_pledge_only = sum(1 for r in rows if r["auec_per_usd"] == -1)
    n_ingame_only = sum(1 for r in rows if r["auec_per_usd"] == 0)
    n_none = sum(1 for r in rows if r["auec_per_usd"] == -2)
    print(f"\n{len(rows)} lignes écrites dans {args.output} "
          f"({n_both} avec les 2 prix, {n_ingame_only} en jeu seulement, "
          f"{n_pledge_only} pledge seulement, {n_none} sans aucun prix)")


if __name__ == "__main__":
    main()
