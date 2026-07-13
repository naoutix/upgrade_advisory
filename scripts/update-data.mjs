#!/usr/bin/env node
// Génère docs/data.json pour l'app statique Pledge Fair — Upgrade Advisor.
//
// Port JavaScript (Node.js) de l'ancien upgrade_advisor.py : ce script tourne
// côté serveur (dans une GitHub Action planifiée), donc sans les restrictions
// CORS qui empêchent le navigateur d'interroger directement UEX ou le vrai
// catalogue RSI. Le navigateur, lui, se contente de charger docs/data.json
// (même origine, aucun souci CORS).
//
// Sources, par ordre de priorité (voir chaque fonction fetch* ci-dessous) :
//   1. L'API officielle UEX 2.0 (api.uexcorp.uk, pas de clé requise en
//      lecture) : prix aUEC en jeu + prix pledge de référence. Le site
//      uexcorp.space (pages HTML) bloque les IP des runners GitHub Actions,
//      d'où l'usage de l'API dédiée aux outils tiers plutôt que du scraping.
//   2. Le pledge store RSI lui-même (API interne non documentée, persisted
//      queries Apollo) : catalogues "Standalone Ships" et "Packs" réels.
//   3. L'outil d'upgrade RSI (API non documentée) : repli si 2. est indisponible.
//   4. Le Ship Matrix officiel RSI : statut Concept.
//   5. Le wiki communautaire (starcitizen.tools) : packs réservés aux membres
//      Concierge, invisibles dans le catalogue public même sans compte.
//
// Usage : node scripts/update-data.mjs [--out docs/data.json] [--packages scripts/packages.txt]

import { load as cheerioLoad } from "cheerio";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const URL_RSI_UPGRADE = "https://robertsspaceindustries.com/pledge-store/api/upgrade/graphql";
const URL_SHIP_MATRIX = "https://robertsspaceindustries.com/ship-matrix/index";

const URL_STOREFRONT_GRAPHQL = "https://robertsspaceindustries.com/graphql";
const HASH_STANDALONE_SHIPS = "ec372b54cbe912fff0590a28ce1db68f339a3367c8cfa48fd591ef9dc82140cb";
const PRODUCT_ID_STANDALONE_SHIPS = 72;
const HASH_PACKS = "7c00a99d486ed837f63885c2b75122237059ee40e08c4d3012559ed1f983bce1";
const PRODUCT_ID_PACKS = 270;

const URL_WIKI_BASE = "https://starcitizen.tools";
const URL_WIKI_PACKAGES = URL_WIKI_BASE + "/List_of_ship_packages";

const HTTP_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

// Variantes de requêtes essayées sur l'endpoint d'upgrade RSI (API non
// officielle : le schéma peut évoluer, d'où plusieurs formes candidates).
const RSI_QUERY_VARIANTS = [
  ["filterShips", `
query filterShips($fromFilters: [FilterConstraintValues], $toFilters: [FilterConstraintValues]) {
  to(filters: $toFilters) {
    ships { id name msrp skus { id title available price } }
  }
}`, { fromFilters: [], toFilters: [] }],
  [null, "query { to { ships { id name msrp skus { id title available price } } } }", null],
  [null, "query { ships { id name msrp skus { id title available price } } }", null],
];

function log(msg) {
  console.error(msg);
}

// ---------------------------------------------------------------------------
// Réseau
// ---------------------------------------------------------------------------

async function fetchText(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      ...options,
      headers: { ...HTTP_HEADERS, ...(options.headers || {}) },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} sur ${url}`);
    return await resp.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, options = {}, timeoutMs = 30000) {
  const text = await fetchText(url, options, timeoutMs);
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Utilitaires de nom
// ---------------------------------------------------------------------------

export function normName(name) {
  const stripped = String(name).normalize("NFKD").replace(/[̀-ͯ]/g, "");
  return stripped.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function wikiShipUrl(name) {
  const words = name.split(/\s+/);
  const bare = words.length > 1 ? words.slice(1).join(" ") : name;
  return `${URL_WIKI_BASE}/${bare.replace(/ /g, "_")}`;
}

export function matchByBareName(uexName, values) {
  const n = normName(uexName);
  if (Object.prototype.hasOwnProperty.call(values, n)) return values[n];
  const words = n.split(" ");
  for (const skip of [1, 2]) {
    if (words.length > skip) {
      const cand = words.slice(skip).join(" ");
      if (Object.prototype.hasOwnProperty.call(values, cand)) return values[cand];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extraction UEX — API officielle 2.0 (pas de scraping HTML)
// ---------------------------------------------------------------------------
//
// Le site uexcorp.space (pages HTML) bloque les requêtes venant des IP des
// runners GitHub Actions (403, probablement une protection anti-bot type
// Cloudflare) alors qu'il n'y a aucun souci en local. UEX publie justement
// une API dédiée aux outils tiers, sur un domaine différent, qui ne bloque
// pas ces IP et ne nécessite pas de clé pour la simple lecture. On l'utilise
// à la place du scraping HTML.

const URL_UEX_API = "https://api.uexcorp.uk/2.0";

async function fetchUexJson(path) {
  const data = await fetchJson(`${URL_UEX_API}/${path}`, { headers: { Accept: "application/json" } });
  if (!data || data.status !== "ok" || !Array.isArray(data.data)) {
    throw new Error(`Réponse UEX API inattendue pour ${path}`);
  }
  return data.data;
}

// UEX conserve un historique de prix par vaisseau ET par devise/région
// (USD, GBP, EUR-FR, EUR-DE, EUR-NL, EUR-AT...), pas une seule ligne par
// vaisseau. Il faut donc explicitement ne garder que l'entrée en USD —
// prendre "la plus récente" toutes devises confondues piocherait parfois
// une entrée en livres ou en euros, faussant le prix affiché en $.
export function usdPriceEntry(priceRows) {
  return priceRows.find((p) => p.currency === "USD") || null;
}

async function fetchUexRoster() {
  log(`Vérification UEX (${URL_UEX_API}) ...`);
  const [vehicles, prices, purchases] = await Promise.all([
    fetchUexJson("vehicles"),
    fetchUexJson("vehicles_prices"),
    fetchUexJson("vehicles_purchases_prices_all"),
  ]);

  const vehicleById = new Map(vehicles.map((v) => [v.id, v]));

  const pricesByVehicle = new Map();
  for (const p of prices) {
    if (!pricesByVehicle.has(p.id_vehicle)) pricesByVehicle.set(p.id_vehicle, []);
    pricesByVehicle.get(p.id_vehicle).push(p);
  }

  const pledge = vehicles.map((v) => {
    const usd = usdPriceEntry(pricesByVehicle.get(v.id) || []);
    let pledgePrice = null;
    let available = false;
    if (usd) {
      const std = usd.price > 0 ? usd.price : null;
      const wb = usd.price_warbond > 0 ? usd.price_warbond : null;
      pledgePrice = std != null ? std : wb;
      available = Boolean(usd.on_sale || usd.on_sale_warbond);
    }
    return {
      key: String(v.id), name: v.name_full,
      pledge: pledgePrice, available, concept: v.is_concept === 1,
    };
  });

  const inGame = {};
  for (const row of purchases) {
    if (!(row.price_buy > 0)) continue;
    const v = vehicleById.get(row.id_vehicle);
    if (!v) continue;
    const key = String(row.id_vehicle);
    if (!inGame[key]) inGame[key] = { name: v.name_full, locations: [] };
    inGame[key].locations.push({ loc: row.terminal_name, auec: row.price_buy });
  }

  return { pledge, inGame };
}

// ---------------------------------------------------------------------------
// Ship Matrix officiel RSI (statut Concept)
// ---------------------------------------------------------------------------

async function fetchShipMatrix() {
  log(`Vérification Ship Matrix (${URL_SHIP_MATRIX}) ...`);
  let data;
  try {
    data = await fetchJson(URL_SHIP_MATRIX, { headers: { Accept: "application/json" } });
  } catch (exc) {
    log(`Avertissement: Ship Matrix inaccessible (${exc}). Statut Concept basé sur UEX uniquement.`);
    return null;
  }
  const ships = data && data.data;
  if (!Array.isArray(ships) || ships.length === 0) {
    log("Avertissement: réponse Ship Matrix sans liste de vaisseaux reconnaissable, ignorée.");
    return null;
  }
  const result = {};
  for (const s of ships) {
    if (!s.name || !s.production_status) continue;
    result[normName(String(s.name))] = String(s.production_status).trim().toLowerCase() === "in-concept";
  }
  return Object.keys(result).length ? result : null;
}

// ---------------------------------------------------------------------------
// Pledge store RSI direct (persisted queries Apollo)
// ---------------------------------------------------------------------------

async function fetchStorefrontListing(operationName, sha256, facet, productId, referer, pageSize = 100) {
  const resources = [];
  let page = 1;
  let total = null;
  while (total === null || resources.length < total) {
    const payload = [{
      operationName,
      variables: {
        storeFront: "pledge",
        query: {
          page, limit: pageSize,
          skus: { filtersFromTags: { tagIdentifiers: [], facetIdentifiers: [facet] }, products: [productId] },
          sort: { field: "name", direction: "asc" },
        },
      },
      extensions: { persistedQuery: { version: 1, sha256Hash: sha256 } },
    }];
    const data = await fetchJson(URL_STOREFRONT_GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: referer, Origin: "https://robertsspaceindustries.com" },
      body: JSON.stringify(payload),
    });
    const listing = data[0].data.store.listing;
    const batch = listing.resources;
    if (!batch || batch.length === 0) break;
    resources.push(...batch);
    total = listing.totalCount ?? resources.length;
    page += 1;
    if (page > 20) break; // garde-fou anti-boucle
  }
  return resources;
}

async function fetchStorefrontStandaloneShips() {
  log(`Vérification du catalogue Standalone Ships (${URL_STOREFRONT_GRAPHQL}) ...`);
  let resources;
  try {
    resources = await fetchStorefrontListing(
      "GetBrowseSkusStandaloneShipByFilter", HASH_STANDALONE_SHIPS,
      "extras-standalone-ships", PRODUCT_ID_STANDALONE_SHIPS,
      "https://robertsspaceindustries.com/store/pledge/browse/extras/standalone-ships");
  } catch (exc) {
    log(`Avertissement: catalogue Standalone Ships inaccessible (${exc}). Repli sur l'outil d'upgrade RSI / UEX.`);
    return null;
  }
  const result = {};
  for (const r of resources) {
    if (!r.name) continue;
    const native = r.nativePrice && r.nativePrice.amount;
    result[normName(String(r.name))] = {
      available: Boolean(r.stock && r.stock.available),
      price: typeof native === "number" ? native / 100 : null,
    };
  }
  return Object.keys(result).length ? result : null;
}

async function fetchStorefrontPacks() {
  log(`Vérification des packs en vente (${URL_STOREFRONT_GRAPHQL}) ...`);
  let resources;
  try {
    resources = await fetchStorefrontListing(
      "GetBrowseSkusByFilter", HASH_PACKS, "extras-packs", PRODUCT_ID_PACKS,
      "https://robertsspaceindustries.com/store/pledge/browse/extras/packs");
  } catch (exc) {
    log(`Avertissement: catalogue Packs inaccessible (${exc}). Les noms de pack proviendront uniquement de packages.txt.`);
    return null;
  }
  return resources.filter((r) => r.name).map((r) => ({ name: r.name, excerpt: r.excerpt || "" }));
}

// ---------------------------------------------------------------------------
// Wiki communautaire : packs réservés aux membres Concierge
// ---------------------------------------------------------------------------

// Équivalent de BeautifulSoup get_text(separator, strip=True) : parcourt tous
// les noeuds texte du sous-arbre (peu importe la structure — <li>, <br>,
// texte brut) et les joint avec 'sep'. Nécessaire ici car "Included ships"
// utilise une liste <ul><li> sur le wiki, pas des <br>.
function collectText($, node, texts) {
  $(node).contents().each((_, child) => {
    if (child.type === "text") {
      const t = (child.data || "").trim();
      if (t) texts.push(t);
    } else if (child.type === "tag") {
      collectText($, child, texts);
    }
  });
}

function getTextJoined($, el, sep = "|") {
  const texts = [];
  collectText($, el, texts);
  return texts.join(sep);
}

async function fetchWikiConciergePacks() {
  log(`Vérification des packs Concierge (${URL_WIKI_PACKAGES}) ...`);
  let html;
  try {
    html = await fetchText(URL_WIKI_PACKAGES);
  } catch (exc) {
    log(`Avertissement: wiki des packs inaccessible (${exc}). Les packs Concierge ne seront pas détectés automatiquement.`);
    return null;
  }
  const $ = cheerioLoad(html);
  const packs = [];
  $("table.wikitable, table.article-table").each((_, table) => {
    const rows = $(table).find("tr").toArray();
    if (rows.length === 0) return;
    const headers = $(rows[0]).find("th, td").map((__, c) => $(c).text().trim()).get();
    const iName = headers.indexOf("Name");
    const iShips = headers.indexOf("Included ships");
    const iAvail = headers.indexOf("Availability");
    if (iName === -1 || iShips === -1 || iAvail === -1) return;
    for (const tr of rows.slice(1)) {
      const cells = $(tr).find("td, th");
      if (cells.length <= Math.max(iName, iShips, iAvail)) continue;
      const availText = cells.eq(iAvail).text().trim().toLowerCase();
      if (!availText.includes("concierge")) continue;
      const name = cells.eq(iName).text().trim();
      const shipsText = getTextJoined($, cells.get(iShips), "|");
      const ships = shipsText.split("|").map((s) => s.trim()).filter(Boolean);
      if (name && ships.length) packs.push({ name, ships });
    }
  });
  return packs.length ? packs : null;
}

// ---------------------------------------------------------------------------
// Outil d'upgrade RSI (repli si le catalogue direct est indisponible)
// ---------------------------------------------------------------------------

function findShipsList(node) {
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => x && typeof x === "object" && "name" in x && "skus" in x)) return node;
    for (const item of node) {
      const found = findShipsList(item);
      if (found) return found;
    }
  } else if (node && typeof node === "object") {
    for (const value of Object.values(node)) {
      const found = findShipsList(value);
      if (found) return found;
    }
  }
  return null;
}

function parseRsiResponse(data) {
  const ships = findShipsList(data);
  if (!ships) {
    log("Avertissement: réponse RSI sans liste de vaisseaux reconnaissable, ignorée.");
    return null;
  }
  const result = {};
  for (const s of ships) {
    const skus = s.skus || [];
    const buyable = skus.some((sku) => sku && typeof sku === "object" && sku.available);
    result[normName(String(s.name))] = buyable;
  }
  return Object.keys(result).length ? result : null;
}

async function rsiPost(query, variables, operationName) {
  const payload = { query };
  if (variables !== null && variables !== undefined) payload.variables = variables;
  if (operationName) payload.operationName = operationName;
  const resp = await fetch(URL_RSI_UPGRADE, {
    method: "POST",
    headers: { ...HTTP_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* pas du JSON */ }
  return [resp.status, data, text];
}

async function fetchRsiStandalone() {
  log(`Vérification RSI (${URL_RSI_UPGRADE}) ...`);
  try {
    const [status0, , text0] = await rsiPost("query { __typename }");
    if (status0 !== 200) {
      log(`Avertissement: API RSI inaccessible (HTTP ${status0}) : ${text0.slice(0, 300)}`);
      return null;
    }
    const errors = [];
    for (const [opName, query, variables] of RSI_QUERY_VARIANTS) {
      const [status, data, text] = await rsiPost(query, variables, opName);
      if (data) {
        if (data.data) {
          const result = parseRsiResponse(data);
          if (result) return result;
        }
        for (const e of data.errors || []) errors.push(String(e.message || e).slice(0, 200));
      } else if (status !== 200) {
        errors.push(`HTTP ${status}: ${text.slice(0, 200)}`);
      }
    }
    log("Avertissement: aucune requête RSI n'a abouti.");
    for (const e of [...new Set(errors)]) log(`  - ${e}`);
    return null;
  } catch (exc) {
    log(`Avertissement: API RSI inaccessible (${exc}). Classification 'Package' basée sur packages.txt uniquement.`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Recoupement vaisseaux <-> packs
// ---------------------------------------------------------------------------

export function bareNameCandidates(names) {
  const out = new Set();
  for (const name of names) {
    const n = normName(name);
    if (n.length >= 3) out.add(n);
    const words = n.split(" ");
    for (const skip of [1, 2]) {
      if (words.length > skip) {
        const cand = words.slice(skip).join(" ");
        if (cand.length >= 3) out.add(cand);
      }
    }
  }
  return out;
}

export function matchShipsToPacks(packs, shipNames) {
  const result = {};
  for (const pack of packs) {
    const text = normName(pack.excerpt);
    for (const candidate of shipNames) {
      if (candidate in result) continue;
      const re = new RegExp(`(?:^|\\s)${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`);
      if (re.test(text)) result[candidate] = { pack: pack.name, concierge: false };
    }
  }
  return result;
}

export function matchShipsToConciergePacks(packs) {
  const result = {};
  const sorted = [...packs].sort((a, b) => a.ships.length - b.ships.length);
  for (const pack of sorted) {
    for (const token of pack.ships) {
      const key = normName(token);
      if (key.length < 3 || key in result) continue;
      result[key] = { pack: pack.name, concierge: true };
    }
  }
  return result;
}

async function loadPackagesFile(path) {
  const out = {};
  if (!path || !existsSync(path)) return out;
  const text = await readFile(path, "utf-8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|").map((p) => p.trim());
    const pack = parts.length > 1 && parts[1] ? parts[1] : null;
    const concierge = parts.length > 2 && ["concierge", "oui", "yes", "true", "1"].includes(parts[2].toLowerCase());
    out[normName(parts[0])] = { pack, concierge };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fusion des données
// ---------------------------------------------------------------------------

export function buildDataset(inGame, pledge, storefrontStandalone, storefrontPacks,
                      wikiConciergePacks, rsi, shipMatrix, manualPackages) {
  const inGameByName = {};
  for (const v of Object.values(inGame)) inGameByName[normName(v.name)] = v;
  const used = new Set();
  const ships = [];

  let shipToPack = {};
  if (storefrontPacks) {
    const candidates = bareNameCandidates(pledge.map((p) => p.name));
    if (shipMatrix) for (const k of Object.keys(shipMatrix)) candidates.add(k);
    shipToPack = matchShipsToPacks(storefrontPacks, candidates);
  }
  if (wikiConciergePacks) {
    for (const [key, val] of Object.entries(matchShipsToConciergePacks(wikiConciergePacks))) {
      if (!(key in shipToPack)) shipToPack[key] = val;
    }
  }

  function conceptFor(name, uexConcept) {
    if (shipMatrix === null) return uexConcept;
    const really = matchByBareName(name, shipMatrix);
    return really === null ? uexConcept : really;
  }

  for (const p of pledge) {
    const ig = (p.key && inGame[p.key]) || inGameByName[normName(p.name)];
    const locations = ig ? [...ig.locations].sort((a, b) => a.auec - b.auec) : [];
    if (ig) used.add(ig);
    const best = locations.length ? locations[0] : null;

    const storefrontMatch = storefrontStandalone !== null
      ? matchByBareName(p.name, storefrontStandalone) : null;
    let available;
    if (storefrontStandalone !== null) {
      available = Boolean(storefrontMatch && storefrontMatch.available);
    } else {
      available = p.available;
    }

    // Repli quand le catalogue Standalone Ships est indisponible : si UEX
    // pense le vaisseau achetable mais que l'outil d'upgrade RSI ne le liste
    // pas en standalone, c'est qu'il n'est en réalité vendu qu'en pack. On
    // corrige la disponibilité (l'outil d'upgrade ne fournit pas de nom de
    // pack, d'où le drapeau séparé consommé plus bas).
    let rsiPackageOnly = false;
    if (storefrontStandalone === null && rsi !== null && available) {
      const really = matchByBareName(p.name, rsi);
      if (really === false) {
        available = false;
        rsiPackageOnly = true;
      }
    }

    let pledgePrice = p.pledge;
    if (pledgePrice == null && storefrontMatch && storefrontMatch.price != null) {
      pledgePrice = storefrontMatch.price;
    }

    let packageOnly = false;
    let packName = null;
    let packConcierge = false;
    const manualKey = normName(p.name);
    if (manualKey in manualPackages) {
      packageOnly = true;
      packName = manualPackages[manualKey].pack;
      packConcierge = manualPackages[manualKey].concierge;
      available = false;
    } else if (!available) {
      const matchedPack = Object.keys(shipToPack).length ? matchByBareName(p.name, shipToPack) : null;
      if (matchedPack) {
        packageOnly = true;
        packName = matchedPack.pack;
        packConcierge = matchedPack.concierge;
      } else if (rsiPackageOnly) {
        packageOnly = true;
      }
    }

    ships.push({
      name: p.name,
      pledge: pledgePrice,
      available,
      packageOnly,
      packName,
      packConcierge,
      concept: conceptFor(p.name, p.concept),
      wikiUrl: wikiShipUrl(p.name),
      auec: best ? best.auec : null,
      loc: best ? best.loc : null,
      ratio: best && pledgePrice ? Math.round((best.auec / pledgePrice) * 100) / 100 : null,
    });
  }

  for (const ig of Object.values(inGame)) {
    if (used.has(ig)) continue;
    const locations = [...ig.locations].sort((a, b) => a.auec - b.auec);
    const best = locations[0];
    ships.push({
      name: ig.name, pledge: null, available: false,
      packageOnly: false, packName: null, packConcierge: false,
      concept: conceptFor(ig.name, false),
      wikiUrl: wikiShipUrl(ig.name),
      auec: best.auec, loc: best.loc, ratio: null,
    });
  }

  ships.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return ships;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { out: "docs/data.json", packages: "scripts/packages.txt" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--packages") args.packages = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const [storefrontStandalone, storefrontPacks, wikiConciergePacks, rsi, shipMatrix, uex] =
    await Promise.all([
      fetchStorefrontStandaloneShips(),
      fetchStorefrontPacks(),
      fetchWikiConciergePacks(),
      fetchRsiStandalone(),
      fetchShipMatrix(),
      fetchUexRoster(),
    ]);
  const { inGame, pledge } = uex;

  const manualPackages = await loadPackagesFile(args.packages);

  const ships = buildDataset(inGame, pledge, storefrontStandalone, storefrontPacks,
    wikiConciergePacks, rsi, shipMatrix, manualPackages);

  const meta = {
    generatedAt: new Date().toISOString(),
    storefrontOk: storefrontStandalone !== null,
    rsiOk: rsi !== null,
    shipMatrixOk: shipMatrix !== null,
    conciergeWikiOk: wikiConciergePacks !== null,
  };

  await writeFile(args.out, JSON.stringify({ meta, ships }, null, 2), "utf-8");

  const nAv = ships.filter((s) => s.available && !s.packageOnly).length;
  const nPk = ships.filter((s) => s.packageOnly).length;
  const nPkConcierge = ships.filter((s) => s.packageOnly && s.packConcierge).length;
  const nRatio = ships.filter((s) => s.ratio !== null).length;
  const nConcept = ships.filter((s) => s.concept).length;
  log(`${args.out} généré : ${ships.length} vaisseaux — ${nAv} achetables standalone, `
    + `${nPk} en pack uniquement (dont ${nPkConcierge} Concierge), `
    + `${nRatio} avec ratio calculable, ${nConcept} en concept.`);
}

// Ne lance le pipeline que lorsque le fichier est exécuté directement
// (node scripts/update-data.mjs). Importé depuis les tests, il n'expose que
// ses fonctions pures, sans déclencher le moindre appel réseau.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((exc) => {
    console.error(exc);
    process.exit(1);
  });
}
