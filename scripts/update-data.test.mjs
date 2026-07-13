// Tests des fonctions pures de update-data.mjs (node --test, sans dépendance).
//
// On ne teste ici que la logique déterministe (normalisation de noms,
// appariement vaisseau/pack, fusion des sources) : aucun appel réseau, donc
// rapide et reproductible en CI. Le point le plus important est la
// non-régression du repli RSI (voir "buildDataset — repli RSI"), un bug qui
// avait atteint la production faute de test.

import { test } from "node:test";
import assert from "node:assert/strict";

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
  const values = { "carrack": "B" };
  assert.equal(matchByBareName("Anvil Carrack", values), "B");
});

test("matchByBareName renvoie null si rien ne correspond", () => {
  assert.equal(matchByBareName("Anvil Carrack", { "cutlass": "X" }), null);
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
  assert.deepEqual(parseArgs([]), { out: "docs/data.json", packages: "scripts/packages.txt" });
});

test("parseArgs lit --out et --packages", () => {
  const a = parseArgs(["--out", "x.json", "--packages", "p.txt"]);
  assert.equal(a.out, "x.json");
  assert.equal(a.packages, "p.txt");
});

// ---------------------------------------------------------------------------
// storefrontListingFromEnvelope
// ---------------------------------------------------------------------------

test("storefrontListingFromEnvelope extrait le listing d'une enveloppe valide", () => {
  const env = [{ data: { store: { listing: { resources: [{ name: "Carrack" }], totalCount: 1 } } } }];
  const listing = storefrontListingFromEnvelope(env, "Op", 1);
  assert.equal(listing.totalCount, 1);
  assert.equal(listing.resources[0].name, "Carrack");
});

test("storefrontListingFromEnvelope signale les erreurs GraphQL", () => {
  const env = [{ errors: [{ message: "PersistedQueryNotFound" }] }];
  assert.throws(() => storefrontListingFromEnvelope(env, "Op", 1), /Erreurs GraphQL.*PersistedQueryNotFound/);
});

test("storefrontListingFromEnvelope signale une structure inattendue", () => {
  assert.throws(() => storefrontListingFromEnvelope([{ data: {} }], "Op", 2), /Structure inattendue/);
  assert.throws(() => storefrontListingFromEnvelope([], "Op", 1), /tableau attendu/);
  assert.throws(() => storefrontListingFromEnvelope(null, "Op", 1), /tableau attendu/);
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
    {}, carrackPledge(true),
    null,           // storefrontStandalone indisponible
    null, null,     // storefrontPacks, wikiConciergePacks
    { carrack: false }, // RSI : pas achetable seul
    null, {},       // shipMatrix, manualPackages
  );
  assert.equal(ships.length, 1);
  assert.equal(ships[0].available, false);
  assert.equal(ships[0].packageOnly, true);
});

test("buildDataset : RSI confirme la disponibilité → reste achetable", () => {
  const ships = buildDataset(
    {}, carrackPledge(true),
    null, null, null,
    { carrack: true }, // RSI : achetable seul
    null, {},
  );
  assert.equal(ships[0].available, true);
  assert.equal(ships[0].packageOnly, false);
});

test("buildDataset : storefront disponible → le repli RSI est ignoré", () => {
  const ships = buildDataset(
    {}, carrackPledge(true),
    { carrack: { available: true, price: 600 } }, // storefront dit achetable
    null, null,
    { carrack: false }, // RSI dirait le contraire, mais storefront a le dernier mot
    null, {},
  );
  assert.equal(ships[0].available, true);
  assert.equal(ships[0].packageOnly, false);
});

test("buildDataset : une correction manuelle a priorité et force le pack", () => {
  const ships = buildDataset(
    {}, carrackPledge(true),
    { carrack: { available: true, price: 600 } },
    null, null, null, null,
    { "anvil carrack": { pack: "Pack Manuel", concierge: true } },
  );
  assert.equal(ships[0].available, false);
  assert.equal(ships[0].packageOnly, true);
  assert.equal(ships[0].packName, "Pack Manuel");
  assert.equal(ships[0].packConcierge, true);
});
