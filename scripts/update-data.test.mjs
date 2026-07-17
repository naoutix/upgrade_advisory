// Tests des fonctions pures de update-data.mjs (node --test, sans dépendance).
//
// On ne teste ici que la logique déterministe (normalisation de noms,
// appariement vaisseau/pack, fusion des sources) : aucun appel réseau, donc
// rapide et reproductible en CI. Le point le plus important est la
// non-régression du repli RSI (voir "buildDataset — repli RSI"), un bug qui
// avait atteint la production faute de test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normName,
  wikiShipUrl,
  matchByBareName,
  usdPriceEntry,
  bareNameCandidates,
  matchShipsToPacks,
  matchShipsToConciergePacks,
  parseArgs,
  buildDataset,
  storefrontListingFromEnvelope,
  resolveGeneratedAt,
  buildUexRoster,
  parseShipMatrix,
  parseWikiConciergePacks,
  parseRsiResponse,
  loadPackagesFile,
  rosterHealth,
} from "./update-data.mjs";

// ---------------------------------------------------------------------------
// normName
// ---------------------------------------------------------------------------

test("normName met en minuscules et normalise les séparateurs", () => {
  assert.equal(normName("Anvil Carrack"), "anvil carrack");
  assert.equal(normName("F7C-M Super Hornet"), "f7c m super hornet");
  assert.equal(normName("  Drake   Cutlass  "), "drake cutlass");
});

test("normName retire les diacritiques", () => {
  assert.equal(normName("Ávila"), "avila");
  assert.equal(normName("Constellation Phœnix").includes("ph"), true);
});

// ---------------------------------------------------------------------------
// wikiShipUrl
// ---------------------------------------------------------------------------

test("wikiShipUrl retire le constructeur et encode les espaces", () => {
  assert.equal(wikiShipUrl("Anvil Carrack"), "https://starcitizen.tools/Carrack");
  assert.equal(wikiShipUrl("Drake Cutlass Black"), "https://starcitizen.tools/Cutlass_Black");
});

test("wikiShipUrl garde un nom d'un seul mot tel quel", () => {
  assert.equal(wikiShipUrl("Nomad"), "https://starcitizen.tools/Nomad");
});

// ---------------------------------------------------------------------------
// matchByBareName
// ---------------------------------------------------------------------------

test("matchByBareName trouve par nom complet normalisé", () => {
  const values = { "anvil carrack": "A" };
  assert.equal(matchByBareName("Anvil Carrack", values), "A");
});

test("matchByBareName retombe sur le nom sans constructeur", () => {
  const values = { carrack: "B" };
  assert.equal(matchByBareName("Anvil Carrack", values), "B");
});

test("matchByBareName renvoie null si rien ne correspond", () => {
  assert.equal(matchByBareName("Anvil Carrack", { cutlass: "X" }), null);
});

// ---------------------------------------------------------------------------
// usdPriceEntry
// ---------------------------------------------------------------------------

test("usdPriceEntry ne retient que la ligne USD", () => {
  const rows = [
    { currency: "EUR", price: 100 },
    { currency: "USD", price: 110 },
    { currency: "GBP", price: 95 },
  ];
  assert.equal(usdPriceEntry(rows).price, 110);
});

test("usdPriceEntry renvoie null sans ligne USD", () => {
  assert.equal(usdPriceEntry([{ currency: "EUR", price: 100 }]), null);
  assert.equal(usdPriceEntry([]), null);
});

// ---------------------------------------------------------------------------
// bareNameCandidates
// ---------------------------------------------------------------------------

test("bareNameCandidates génère les variantes sans constructeur", () => {
  const cands = bareNameCandidates(["Anvil Carrack"]);
  assert.equal(cands.has("anvil carrack"), true);
  assert.equal(cands.has("carrack"), true);
});

test("bareNameCandidates écarte les fragments trop courts", () => {
  const cands = bareNameCandidates(["RSI X1"]); // "x1" fait 2 caractères
  assert.equal(cands.has("x1"), false);
  assert.equal(cands.has("rsi x1"), true);
});

// ---------------------------------------------------------------------------
// matchShipsToPacks
// ---------------------------------------------------------------------------

test("matchShipsToPacks associe un vaisseau cité dans l'excerpt du pack", () => {
  const packs = [{ name: "Best In Show 2953", excerpt: "Includes the Carrack and more" }];
  const result = matchShipsToPacks(packs, new Set(["carrack", "cutlass"]));
  assert.deepEqual(result.carrack, { pack: "Best In Show 2953", concierge: false });
  assert.equal("cutlass" in result, false);
});

// ---------------------------------------------------------------------------
// matchShipsToConciergePacks
// ---------------------------------------------------------------------------

test("matchShipsToConciergePacks marque les vaisseaux comme concierge", () => {
  const packs = [{ name: "Concierge Pack", ships: ["Carrack", "Idris-P"] }];
  const result = matchShipsToConciergePacks(packs);
  assert.equal(result.carrack.concierge, true);
  assert.equal(result.carrack.pack, "Concierge Pack");
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test("parseArgs applique les valeurs par défaut", () => {
  assert.deepEqual(parseArgs([]), {
    out: "docs/data.json",
    packages: "scripts/packages.txt",
    force: false,
  });
});

test("parseArgs lit --out et --packages", () => {
  const a = parseArgs(["--out", "x.json", "--packages", "p.txt"]);
  assert.equal(a.out, "x.json");
  assert.equal(a.packages, "p.txt");
});

test("parseArgs lit le drapeau --force", () => {
  assert.equal(parseArgs([]).force, false);
  assert.equal(parseArgs(["--force"]).force, true);
});

// ---------------------------------------------------------------------------
// storefrontListingFromEnvelope
// ---------------------------------------------------------------------------

test("storefrontListingFromEnvelope extrait le listing d'une enveloppe valide", () => {
  const env = [
    { data: { store: { listing: { resources: [{ name: "Carrack" }], totalCount: 1 } } } },
  ];
  const listing = storefrontListingFromEnvelope(env, "Op", 1);
  assert.equal(listing.totalCount, 1);
  assert.equal(listing.resources[0].name, "Carrack");
});

test("storefrontListingFromEnvelope signale les erreurs GraphQL", () => {
  const env = [{ errors: [{ message: "PersistedQueryNotFound" }] }];
  assert.throws(
    () => storefrontListingFromEnvelope(env, "Op", 1),
    /Erreurs GraphQL.*PersistedQueryNotFound/,
  );
});

test("storefrontListingFromEnvelope signale une structure inattendue", () => {
  assert.throws(
    () => storefrontListingFromEnvelope([{ data: {} }], "Op", 2),
    /Structure inattendue/,
  );
  assert.throws(() => storefrontListingFromEnvelope([], "Op", 1), /tableau attendu/);
  assert.throws(() => storefrontListingFromEnvelope(null, "Op", 1), /tableau attendu/);
});

// ---------------------------------------------------------------------------
// resolveGeneratedAt
// ---------------------------------------------------------------------------

const FLAGS = { storefrontOk: true, rsiOk: true, shipMatrixOk: true, conciergeWikiOk: true };
const SHIPS = [{ name: "Carrack", pledge: 600 }];

test("resolveGeneratedAt : pas de fichier précédent → nouvel horodatage", () => {
  assert.equal(resolveGeneratedAt(null, SHIPS, FLAGS, "NOW"), "NOW");
});

test("resolveGeneratedAt : données et sources inchangées → réutilise l'ancien", () => {
  const prev = { meta: { generatedAt: "OLD", ...FLAGS }, ships: SHIPS };
  assert.equal(resolveGeneratedAt(prev, SHIPS, FLAGS, "NOW"), "OLD");
});

test("resolveGeneratedAt : vaisseaux modifiés → nouvel horodatage", () => {
  const prev = { meta: { generatedAt: "OLD", ...FLAGS }, ships: SHIPS };
  const changed = [{ name: "Carrack", pledge: 650 }];
  assert.equal(resolveGeneratedAt(prev, changed, FLAGS, "NOW"), "NOW");
});

test("resolveGeneratedAt : une source qui tombe → nouvel horodatage", () => {
  const prev = { meta: { generatedAt: "OLD", ...FLAGS }, ships: SHIPS };
  const degraded = { ...FLAGS, storefrontOk: false };
  assert.equal(resolveGeneratedAt(prev, SHIPS, degraded, "NOW"), "NOW");
});

// ---------------------------------------------------------------------------
// rosterHealth — filet de sécurité UEX
// ---------------------------------------------------------------------------

const shipsOfLength = (n) => Array.from({ length: n }, (_, i) => ({ name: `S${i}` }));

test("rosterHealth : roster plein et stable → ok", () => {
  const prev = { ships: shipsOfLength(280) };
  assert.equal(rosterHealth(shipsOfLength(279), prev).ok, true);
});

test("rosterHealth : sous le plancher absolu → échec", () => {
  const h = rosterHealth(shipsOfLength(10), null);
  assert.equal(h.ok, false);
  assert.match(h.reason, /plancher/);
});

test("rosterHealth : effondrement par rapport au run précédent → échec", () => {
  const prev = { ships: shipsOfLength(279) };
  const h = rosterHealth(shipsOfLength(100), prev); // < 50 % de 279
  assert.equal(h.ok, false);
  assert.match(h.reason, /chute brutale/);
});

test("rosterHealth : baisse modérée (au-dessus du seuil) → ok", () => {
  const prev = { ships: shipsOfLength(279) };
  assert.equal(rosterHealth(shipsOfLength(200), prev).ok, true); // ~72 %, toléré
});

test("rosterHealth : premier run sans précédent, roster plein → ok", () => {
  assert.equal(rosterHealth(shipsOfLength(279), null).ok, true);
});

test("rosterHealth : un précédent lui-même minuscule ne sert pas de référence de chute", () => {
  // prevCount (20) < plancher : on ne déclenche pas la règle de chute sur une
  // base douteuse ; seul le plancher absolu s'applique au roster courant.
  const prev = { ships: shipsOfLength(20) };
  assert.equal(rosterHealth(shipsOfLength(279), prev).ok, true);
});

test("rosterHealth : seuils configurables", () => {
  assert.equal(rosterHealth(shipsOfLength(30), null, { minShips: 25 }).ok, true);
  assert.equal(rosterHealth(shipsOfLength(30), null, { minShips: 40 }).ok, false);
});

// ---------------------------------------------------------------------------
// buildDataset — repli RSI (NON-RÉGRESSION)
// ---------------------------------------------------------------------------
//
// Scénario : le catalogue Standalone Ships est indisponible
// (storefrontStandalone === null), UEX pense le vaisseau achetable
// (available: true) mais l'outil d'upgrade RSI ne le liste pas en standalone
// (really === false). Le vaisseau doit alors basculer en "pack uniquement"
// et ne plus être marqué achetable. Ce chemin était mort avant correction.

function carrackPledge(available) {
  return [{ key: "1", name: "Anvil Carrack", pledge: 600, available, concept: false }];
}

test("buildDataset : RSI rétrograde un vaisseau achetable en pack quand le storefront est down", () => {
  const ships = buildDataset(
    {},
    carrackPledge(true),
    null, // storefrontStandalone indisponible
    null,
    null, // storefrontPacks, wikiConciergePacks
    { carrack: false }, // RSI : pas achetable seul
    null,
    {}, // shipMatrix, manualPackages
  );
  assert.equal(ships.length, 1);
  assert.equal(ships[0].available, false);
  assert.equal(ships[0].packageOnly, true);
});

test("buildDataset : RSI confirme la disponibilité → reste achetable", () => {
  const ships = buildDataset(
    {},
    carrackPledge(true),
    null,
    null,
    null,
    { carrack: true }, // RSI : achetable seul
    null,
    {},
  );
  assert.equal(ships[0].available, true);
  assert.equal(ships[0].packageOnly, false);
});

test("buildDataset : storefront disponible → le repli RSI est ignoré", () => {
  const ships = buildDataset(
    {},
    carrackPledge(true),
    { carrack: { available: true, price: 600 } }, // storefront dit achetable
    null,
    null,
    { carrack: false }, // RSI dirait le contraire, mais storefront a le dernier mot
    null,
    {},
  );
  assert.equal(ships[0].available, true);
  assert.equal(ships[0].packageOnly, false);
});

test("buildDataset : une correction manuelle a priorité et force le pack", () => {
  const ships = buildDataset(
    {},
    carrackPledge(true),
    { carrack: { available: true, price: 600 } },
    null,
    null,
    null,
    null,
    { "anvil carrack": { pack: "Pack Manuel", concierge: true } },
  );
  assert.equal(ships[0].available, false);
  assert.equal(ships[0].packageOnly, true);
  assert.equal(ships[0].packName, "Pack Manuel");
  assert.equal(ships[0].packConcierge, true);
});

// ---------------------------------------------------------------------------
// buildDataset — autres branches
// ---------------------------------------------------------------------------

test("buildDataset : un vaisseau vendu en jeu mais absent du pledge est ajouté (orphelin)", () => {
  const inGame = {
    9: {
      name: "Orphan Ship",
      locations: [
        { loc: "L1", auec: 500 },
        { loc: "L2", auec: 300 },
      ],
    },
  };
  const ships = buildDataset(inGame, [], null, null, null, null, null, {});
  assert.equal(ships.length, 1);
  const s = ships[0];
  assert.equal(s.name, "Orphan Ship");
  assert.equal(s.pledge, null);
  assert.equal(s.available, false);
  assert.equal(s.packageOnly, false);
  assert.equal(s.auec, 300); // la localisation la moins chère
  assert.equal(s.loc, "L2");
  assert.equal(s.ratio, null); // pas de prix pledge → pas de ratio
});

test("buildDataset : prix pledge manquant complété par le storefront + ratio calculé", () => {
  const pledge = [
    { key: "1", name: "Anvil Carrack", pledge: null, available: false, concept: false },
  ];
  const inGame = { 1: { name: "Anvil Carrack", locations: [{ loc: "Area18", auec: 1200000 }] } };
  const ships = buildDataset(
    inGame,
    pledge,
    { carrack: { available: true, price: 600 } }, // storefront : achetable, prix 600
    null,
    null,
    null,
    null,
    {},
  );
  assert.equal(ships[0].pledge, 600); // complété depuis le storefront
  assert.equal(ships[0].available, true);
  assert.equal(ships[0].auec, 1200000);
  assert.equal(ships[0].ratio, 2000); // 1200000 / 600
});

test("buildDataset : le Ship Matrix a le dernier mot sur le statut Concept", () => {
  const pledge = [
    { key: "1", name: "Anvil Carrack", pledge: 600, available: true, concept: false },
  ];
  // UEX dit « pas concept », le Ship Matrix dit « concept » → concept.
  const overridden = buildDataset(
    {},
    pledge,
    { carrack: { available: true, price: 600 } },
    null,
    null,
    null,
    { carrack: true },
    {},
  );
  assert.equal(overridden[0].concept, true);
});

test("buildDataset : sans entrée Ship Matrix correspondante, on garde le statut UEX", () => {
  const pledge = [{ key: "1", name: "Aopoa Nox", pledge: 40, available: true, concept: true }];
  const ships = buildDataset(
    {},
    pledge,
    { nox: { available: true, price: 40 } },
    null,
    null,
    null,
    { carrack: false },
    {},
  ); // pas d'entrée « nox »
  assert.equal(ships[0].concept, true); // repli sur le concept UEX
});

test("buildDataset : un vaisseau indisponible cité dans un pack storefront devient packageOnly", () => {
  const ships = buildDataset(
    {},
    carrackPledge(false), // UEX : pas achetable
    null, // storefront standalone indisponible → available reste false
    [{ name: "Best In Show 2953", excerpt: "Includes the Carrack and more" }],
    null,
    null,
    null,
    {},
  );
  assert.equal(ships[0].available, false);
  assert.equal(ships[0].packageOnly, true);
  assert.equal(ships[0].packName, "Best In Show 2953");
  assert.equal(ships[0].packConcierge, false);
});

test("buildDataset : un pack Concierge du wiki marque le vaisseau comme tel", () => {
  const ships = buildDataset(
    {},
    carrackPledge(false),
    null,
    null,
    [{ name: "Big Benefactor", ships: ["Carrack"] }], // pack concierge du wiki
    null,
    null,
    {},
  );
  assert.equal(ships[0].packageOnly, true);
  assert.equal(ships[0].packName, "Big Benefactor");
  assert.equal(ships[0].packConcierge, true);
});

// ---------------------------------------------------------------------------
// matchShipsToPacks — robustesse de l'appariement
// ---------------------------------------------------------------------------

test("matchShipsToPacks exige une frontière de mot (pas de sous-chaîne)", () => {
  const packs = [{ name: "P", excerpt: "the hypercarrackian device" }];
  const result = matchShipsToPacks(packs, new Set(["carrack"]));
  assert.equal("carrack" in result, false); // « carrack » au milieu d'un mot ne compte pas
});

test("matchShipsToPacks associe un nom multi-mots entouré d'espaces", () => {
  const packs = [{ name: "P", excerpt: "the Anvil Carrack is here" }];
  const result = matchShipsToPacks(packs, new Set(["anvil carrack"]));
  assert.deepEqual(result["anvil carrack"], { pack: "P", concierge: false });
});

// ---------------------------------------------------------------------------
// buildUexRoster — fusion des tableaux bruts UEX
// ---------------------------------------------------------------------------

test("buildUexRoster ne retient que le prix USD et privilégie le prix standard", () => {
  const vehicles = [{ id: 1, name_full: "Anvil Carrack", is_concept: 0 }];
  const prices = [
    { id_vehicle: 1, currency: "EUR", price: 550, price_warbond: 0, on_sale: 1 },
    {
      id_vehicle: 1,
      currency: "USD",
      price: 600,
      price_warbond: 540,
      on_sale: 1,
      on_sale_warbond: 0,
    },
  ];
  const { pledge } = buildUexRoster(vehicles, prices, []);
  assert.equal(pledge[0].pledge, 600); // prix standard USD, pas l'EUR ni le warbond
  assert.equal(pledge[0].available, true); // on_sale
  assert.equal(pledge[0].concept, false);
});

test("buildUexRoster retombe sur le prix warbond quand le standard est absent", () => {
  const vehicles = [{ id: 2, name_full: "RSI Zeus", is_concept: 1 }];
  const prices = [
    {
      id_vehicle: 2,
      currency: "USD",
      price: 0,
      price_warbond: 250,
      on_sale: 0,
      on_sale_warbond: 1,
    },
  ];
  const { pledge } = buildUexRoster(vehicles, prices, []);
  assert.equal(pledge[0].pledge, 250); // repli warbond
  assert.equal(pledge[0].available, true); // on_sale_warbond
  assert.equal(pledge[0].concept, true); // is_concept === 1
});

test("buildUexRoster ignore les achats sans prix ou vers un véhicule inconnu", () => {
  const vehicles = [{ id: 1, name_full: "Anvil Carrack", is_concept: 0 }];
  const purchases = [
    { id_vehicle: 1, terminal_name: "Area18", price_buy: 0 }, // prix nul → ignoré
    { id_vehicle: 1, terminal_name: "NB Int", price_buy: 1000000 },
    { id_vehicle: 99, terminal_name: "Ghost", price_buy: 42 }, // véhicule inconnu → ignoré
  ];
  const { inGame } = buildUexRoster(vehicles, [], purchases);
  assert.deepEqual(Object.keys(inGame), ["1"]);
  assert.deepEqual(inGame["1"].locations, [{ loc: "NB Int", auec: 1000000 }]);
});

// ---------------------------------------------------------------------------
// parseShipMatrix
// ---------------------------------------------------------------------------

test("parseShipMatrix marque comme concept les vaisseaux « in-concept »", () => {
  const ships = [
    { name: "Carrack", production_status: "flight-ready" },
    { name: "Zeus", production_status: "In-Concept" }, // casse indifférente
    { name: "SansStatut" }, // ignoré
  ];
  const result = parseShipMatrix(ships);
  assert.equal(result.carrack, false);
  assert.equal(result.zeus, true);
  assert.equal("sansstatut" in result, false);
});

test("parseShipMatrix renvoie null quand rien n'est exploitable", () => {
  assert.equal(parseShipMatrix([]), null);
  assert.equal(parseShipMatrix([{ name: "X" }]), null); // pas de production_status
});

// ---------------------------------------------------------------------------
// parseWikiConciergePacks
// ---------------------------------------------------------------------------

const WIKI_HTML = `
<table class="wikitable">
  <tr><th>Name</th><th>Included ships</th><th>Availability</th></tr>
  <tr>
    <td>Big Benefactor</td>
    <td><ul><li>Anvil Carrack</li><li>Idris-P</li></ul></td>
    <td>Concierge only</td>
  </tr>
  <tr>
    <td>Starter Pack</td>
    <td><ul><li>Aurora MR</li></ul></td>
    <td>Available now</td>
  </tr>
</table>`;

test("parseWikiConciergePacks ne garde que les lignes Concierge et lit la liste de vaisseaux", () => {
  const packs = parseWikiConciergePacks(WIKI_HTML);
  assert.equal(packs.length, 1);
  assert.equal(packs[0].name, "Big Benefactor");
  assert.deepEqual(packs[0].ships, ["Anvil Carrack", "Idris-P"]);
});

test("parseWikiConciergePacks renvoie null sans ligne Concierge", () => {
  const html = `<table class="wikitable">
    <tr><th>Name</th><th>Included ships</th><th>Availability</th></tr>
    <tr><td>Starter</td><td><ul><li>Aurora</li></ul></td><td>Available now</td></tr>
  </table>`;
  assert.equal(parseWikiConciergePacks(html), null);
});

test("parseWikiConciergePacks ignore les tables sans les bons en-têtes", () => {
  const html = `<table class="wikitable">
    <tr><th>Foo</th><th>Bar</th></tr>
    <tr><td>x</td><td>Concierge</td></tr>
  </table>`;
  assert.equal(parseWikiConciergePacks(html), null);
});

// ---------------------------------------------------------------------------
// parseRsiResponse (+ findShipsList)
// ---------------------------------------------------------------------------

test("parseRsiResponse repère la liste de vaisseaux, même imbriquée, et lit la disponibilité", () => {
  const data = {
    data: {
      to: {
        ships: [
          { name: "Anvil Carrack", skus: [{ available: true }] },
          { name: "RSI Zeus", skus: [{ available: false }] },
        ],
      },
    },
  };
  const result = parseRsiResponse(data);
  assert.equal(result["anvil carrack"], true);
  assert.equal(result["rsi zeus"], false);
});

test("parseRsiResponse renvoie null quand aucune liste de vaisseaux n'est trouvée", () => {
  assert.equal(parseRsiResponse({ data: { to: {} } }), null);
});

// ---------------------------------------------------------------------------
// loadPackagesFile
// ---------------------------------------------------------------------------

test("loadPackagesFile analyse commentaires, synonymes et champs optionnels", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pledgefair-pkg-"));
  const file = join(dir, "packages.txt");
  try {
    await writeFile(
      file,
      [
        "# ceci est un commentaire",
        "",
        "Anvil Carrack | Best In Show | oui",
        "Drake Cutlass | ",
        "Nomad",
        "RSI Zeus | Pack Z | concierge",
      ].join("\n"),
      "utf-8",
    );
    const out = await loadPackagesFile(file);

    assert.deepEqual(out["anvil carrack"], { pack: "Best In Show", concierge: true }); // « oui » = concierge
    assert.deepEqual(out["drake cutlass"], { pack: null, concierge: false }); // 2e champ vide → pas de pack
    assert.deepEqual(out["nomad"], { pack: null, concierge: false }); // champ unique
    assert.deepEqual(out["rsi zeus"], { pack: "Pack Z", concierge: true });
    assert.equal("# ceci est un commentaire" in out, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadPackagesFile renvoie {} pour un chemin absent ou nul", async () => {
  assert.deepEqual(await loadPackagesFile(join(tmpdir(), "n-existe-pas-12345.txt")), {});
  assert.deepEqual(await loadPackagesFile(null), {});
});
