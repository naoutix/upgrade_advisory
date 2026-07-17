// Tests de la logique pure du front-end (docs/core.js), avec node --test.
//
// core.js ne touche jamais au DOM : échappement, formatage, calcul des
// candidats à l'upgrade, tri/filtre des tableaux. On peut donc tout tester
// sans navigateur ni jsdom, rapidement et de façon reproductible en CI.
// app.js, lui, se contente de lire l'état de l'interface et de générer le
// HTML — il n'est pas testé ici (il faudrait un DOM).
//
// Les formats localisés (fr-FR, en-US) dépendent des données ICU : pour
// rester robustes, on n'affirme le séparateur de milliers exact que sur
// en-US (ASCII stable) ; côté fr-FR on retire les espaces avant de comparer.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  esc,
  fmtN,
  fmtUsd,
  formatFreshness,
  packTag,
  isHiddenConcierge,
  statusRank,
  tagsOf,
  computeCandidates,
  applyTableState,
  thSort,
} from "./core.js";

// ---------------------------------------------------------------------------
// esc — frontière de sécurité (XSS)
// ---------------------------------------------------------------------------

test("esc neutralise les balises HTML", () => {
  assert.equal(esc("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
});

test("esc échappe les guillemets pour empêcher une évasion d'attribut", () => {
  assert.equal(esc('" onload="x'), "&quot; onload=&quot;x");
  assert.equal(esc("' onload='x"), "&#39; onload=&#39;x");
});

test("esc échappe l'esperluette et les chevrons", () => {
  assert.equal(esc("a&b<c>d"), "a&amp;b&lt;c&gt;d");
});

test("esc convertit les valeurs non-chaînes sans planter", () => {
  assert.equal(esc(42), "42");
  assert.equal(esc(null), "null");
});

// ---------------------------------------------------------------------------
// fmtN / fmtUsd
// ---------------------------------------------------------------------------

test("fmtN groupe les milliers et arrondit à l'entier", () => {
  assert.equal(fmtN(1234567).replace(/\s/g, ""), "1234567");
  assert.equal(fmtN(1234.6).replace(/\s/g, ""), "1235"); // arrondi
  assert.equal(fmtN(0), "0");
});

test("fmtUsd préfixe d'un $ et garde au plus 2 décimales", () => {
  assert.equal(fmtUsd(600), "$600");
  assert.equal(fmtUsd(1234.5), "$1,234.5");
  assert.equal(fmtUsd(1234.567), "$1,234.57");
  assert.equal(fmtUsd(0), "$0");
});

// ---------------------------------------------------------------------------
// formatFreshness
// ---------------------------------------------------------------------------

test("formatFreshness renvoie un repli lisible sur une date invalide", () => {
  assert.equal(formatFreshness("pas-une-date"), "date inconnue");
  assert.equal(formatFreshness(""), "date inconnue");
});

test("formatFreshness formate une date ISO valide", () => {
  const out = formatFreshness("2026-07-07T15:50:00Z");
  assert.notEqual(out, "date inconnue");
  assert.match(out, /2026/);
  assert.match(out, / à /); // « <date> à <heure> »
});

// ---------------------------------------------------------------------------
// packTag
// ---------------------------------------------------------------------------

test("packTag affiche le nom du pack quand il est connu", () => {
  assert.equal(
    packTag({ packName: "Best In Show", packConcierge: false }),
    '<span class="tag pk">Pack : Best In Show</span>',
  );
});

test("packTag retombe sur « Pack » sans nom, et marque le Concierge", () => {
  assert.equal(
    packTag({ packName: null, packConcierge: false }),
    '<span class="tag pk">Pack</span>',
  );
  assert.equal(
    packTag({ packName: "VIP", packConcierge: true }),
    '<span class="tag pk">Pack : VIP (Concierge)</span>',
  );
});

test("packTag échappe le nom de pack (source wiki éditable)", () => {
  assert.match(
    packTag({ packName: "<b>x</b>", packConcierge: false }),
    /Pack : &lt;b&gt;x&lt;\/b&gt;/,
  );
});

// ---------------------------------------------------------------------------
// isHiddenConcierge / statusRank / tagsOf
// ---------------------------------------------------------------------------

test("isHiddenConcierge : masqué seulement hors Mode Concierge", () => {
  const s = { packageOnly: true, packConcierge: true };
  assert.equal(isHiddenConcierge(s, false), true);
  assert.equal(isHiddenConcierge(s, true), false);
  assert.equal(isHiddenConcierge({ packageOnly: true, packConcierge: false }, false), false);
});

test("statusRank reflète l'étiquette affichée (0 vente, 1 pack, 2 indispo)", () => {
  assert.equal(statusRank({ available: true, packageOnly: false }, false), 0);
  assert.equal(statusRank({ packageOnly: true, packConcierge: false }, false), 1);
  assert.equal(statusRank({ packageOnly: true, packConcierge: true }, false), 2); // concierge masqué
  assert.equal(statusRank({ packageOnly: true, packConcierge: true }, true), 1); // concierge visible
  assert.equal(statusRank({ available: false, packageOnly: false }, false), 2);
});

test("tagsOf choisit la bonne étiquette de statut", () => {
  assert.equal(
    tagsOf({ available: true, packageOnly: false }, false),
    '<span class="tag av">En vente</span>',
  );
  assert.equal(
    tagsOf({ available: false, packageOnly: false }, false),
    '<span class="tag na">Pas en vente</span>',
  );
  assert.equal(
    tagsOf({ packageOnly: true, packConcierge: true }, false),
    '<span class="tag na">Pas en vente</span>', // concierge masqué → « Pas en vente »
  );
  assert.match(tagsOf({ packageOnly: true, packConcierge: false }, false), /tag pk/);
});

test("tagsOf ajoute le tag Concept selon showConcept", () => {
  const s = { available: true, packageOnly: false, concept: true };
  assert.match(tagsOf(s, false), /tag cc">Concept/);
  assert.doesNotMatch(tagsOf(s, false, false), /Concept/);
});

// ---------------------------------------------------------------------------
// computeCandidates — cœur métier
// ---------------------------------------------------------------------------

function fixtureShips() {
  const base = {
    name: "Base",
    pledge: 100,
    ratio: 10,
    auec: 1000,
    available: true,
    packageOnly: false,
    packConcierge: false,
  };
  const ships = [
    base,
    { name: "Cheaper", pledge: 90, ratio: 50, auec: 4500, available: true, packageOnly: false },
    { name: "Equal", pledge: 100, ratio: 50, auec: 5000, available: true, packageOnly: false },
    { name: "AvailGood", pledge: 200, ratio: 20, auec: 4000, available: true, packageOnly: false },
    {
      name: "PackVis",
      pledge: 150,
      ratio: 15,
      auec: 2250,
      available: false,
      packageOnly: true,
      packConcierge: false,
    },
    {
      name: "PackConc",
      pledge: 300,
      ratio: 12,
      auec: 3600,
      available: false,
      packageOnly: true,
      packConcierge: true,
    },
    { name: "Unavail", pledge: 250, ratio: 8, auec: 2000, available: false, packageOnly: false },
    { name: "NoGame", pledge: 400, ratio: null, auec: null, available: true, packageOnly: false },
  ];
  return { base, ships };
}

test("computeCandidates : sans sélection → groupes vides", () => {
  assert.deepEqual(computeCandidates([], null), { avail: [], pack: [], unavail: [], noInGame: [] });
});

test("computeCandidates applique la règle CCU (cible strictement plus chère)", () => {
  const { base, ships } = fixtureShips();
  const c = computeCandidates(ships, base);
  const names = [...c.avail, ...c.pack, ...c.unavail, ...c.noInGame].map((r) => r.name);
  assert.equal(names.includes("Cheaper"), false); // moins cher
  assert.equal(names.includes("Equal"), false); // même prix
  assert.equal(names.includes("Base"), false); // soi-même
});

test("computeCandidates répartit dans les 4 groupes (défaut : Concierge masqué)", () => {
  const { base, ships } = fixtureShips();
  const c = computeCandidates(ships, base);
  assert.deepEqual(
    c.avail.map((r) => r.name),
    ["AvailGood"],
  );
  assert.deepEqual(
    c.pack.map((r) => r.name),
    ["PackVis"],
  );
  assert.deepEqual(c.unavail.map((r) => r.name).sort(), ["PackConc", "Unavail"]); // concierge masqué → unavail
  assert.deepEqual(
    c.noInGame.map((r) => r.name),
    ["NoGame"],
  );
});

test("computeCandidates : Mode Concierge fait remonter le pack Concierge", () => {
  const { base, ships } = fixtureShips();
  const c = computeCandidates(ships, base, { conciergeMode: true });
  assert.equal(c.pack.map((r) => r.name).includes("PackConc"), true);
  assert.equal(c.unavail.map((r) => r.name).includes("PackConc"), false);
  assert.deepEqual(
    c.unavail.map((r) => r.name),
    ["Unavail"],
  );
});

test("computeCandidates calcule cost, marginal et gain", () => {
  const { base, ships } = fixtureShips();
  const c = computeCandidates(ships, base);
  const good = c.avail.find((r) => r.name === "AvailGood");
  assert.equal(good.cost, 100); // 200 - 100
  assert.equal(good.marginal, 30); // (4000 - 1000) / 100
  assert.equal(good.gain, 100); // (20/10 - 1) * 100
});

test("computeCandidates : onlyBetter écarte les ratios <= au ratio actuel", () => {
  const { base, ships } = fixtureShips();
  const c = computeCandidates(ships, base, { onlyBetter: true });
  // Unavail (ratio 8 <= 10) disparaît ; PackConc (ratio 12) reste.
  assert.deepEqual(
    c.unavail.map((r) => r.name),
    ["PackConc"],
  );
});

test("computeCandidates : base sans prix en jeu → marginal = auec cible / cost", () => {
  const base = {
    name: "B",
    pledge: 100,
    ratio: null,
    auec: null,
    available: true,
    packageOnly: false,
  };
  const target = {
    name: "T",
    pledge: 200,
    ratio: 20,
    auec: 4000,
    available: true,
    packageOnly: false,
  };
  const c = computeCandidates([base, target], base);
  const t = c.avail.find((r) => r.name === "T");
  assert.equal(t.marginal, 40); // 4000 / 100 (pas de base.auec à soustraire)
  assert.equal(t.gain, null); // base.ratio null → gain non calculable
});

// Fixture dédiée au tri : 3 cibles toutes « achetables standalone », donc
// toutes dans le groupe avail — le groupe reflète alors directement l'ordre
// de tri global. Les clés de tri donnent des ordres distincts, ce qui permet
// de vérifier que sortBy est bien pris en compte.
function sortShips() {
  const base = {
    name: "Base",
    pledge: 100,
    ratio: 10,
    auec: 1000,
    available: true,
    packageOnly: false,
  };
  const mk = (name, pledge, ratio, auec) => ({
    name,
    pledge,
    ratio,
    auec,
    available: true,
    packageOnly: false,
  });
  return {
    base,
    ships: [
      base,
      mk("A", 300, 5, 1500), // cost 200, marginal 2.5
      mk("B", 150, 30, 4500), // cost 50,  marginal 70
      mk("C", 500, 20, 10000), // cost 400, marginal 22.5
    ],
  };
}

test("computeCandidates : tri par ratio décroissant (défaut)", () => {
  const { base, ships } = sortShips();
  const c = computeCandidates(ships, base);
  assert.deepEqual(
    c.avail.map((r) => r.name),
    ["B", "C", "A"],
  ); // 30, 20, 5
});

test("computeCandidates : tri par coût croissant", () => {
  const { base, ships } = sortShips();
  const c = computeCandidates(ships, base, { sortBy: "cost" });
  assert.deepEqual(
    c.avail.map((r) => r.name),
    ["B", "A", "C"],
  ); // 50, 200, 400
});

test("computeCandidates : tri par prix pledge croissant", () => {
  const { base, ships } = sortShips();
  const c = computeCandidates(ships, base, { sortBy: "pledge" });
  assert.deepEqual(
    c.avail.map((r) => r.name),
    ["B", "A", "C"],
  ); // 150, 300, 500
});

test("computeCandidates : tri par rendement marginal décroissant", () => {
  const { base, ships } = sortShips();
  const c = computeCandidates(ships, base, { sortBy: "marginal" });
  assert.deepEqual(
    c.avail.map((r) => r.name),
    ["B", "C", "A"],
  ); // 70, 22.5, 2.5
});

test("computeCandidates : noInGame trié par prix pledge croissant", () => {
  const base = {
    name: "B",
    pledge: 100,
    ratio: 10,
    auec: 1000,
    available: true,
    packageOnly: false,
  };
  const ships = [
    base,
    { name: "N2", pledge: 500, ratio: null, auec: null, available: false, packageOnly: false },
    { name: "N1", pledge: 300, ratio: null, auec: null, available: false, packageOnly: false },
  ];
  const c = computeCandidates(ships, base);
  assert.deepEqual(
    c.noInGame.map((r) => r.name),
    ["N1", "N2"],
  );
});

// ---------------------------------------------------------------------------
// applyTableState — filtre puis tri
// ---------------------------------------------------------------------------

const NO_STATE = { sort: null, dir: 1, filter: "" };

test("applyTableState sans tri ni filtre renvoie les lignes inchangées", () => {
  const rows = [{ name: "b" }, { name: "a" }];
  assert.deepEqual(applyTableState(NO_STATE, rows, ["name"]), rows);
});

test("applyTableState filtre par sous-chaîne sur les champs demandés", () => {
  const rows = [{ name: "Anvil Carrack" }, { name: "Drake Cutlass" }];
  const out = applyTableState({ sort: null, dir: 1, filter: "carr" }, rows, ["name"]);
  assert.deepEqual(
    out.map((r) => r.name),
    ["Anvil Carrack"],
  );
});

test("applyTableState filtre sur plusieurs champs (name + packName)", () => {
  const rows = [
    { name: "Carrack", packName: null },
    { name: "Cutlass", packName: "Best In Show" },
  ];
  const out = applyTableState({ sort: null, dir: 1, filter: "show" }, rows, ["name", "packName"]);
  assert.deepEqual(
    out.map((r) => r.name),
    ["Cutlass"],
  );
});

test("applyTableState trie les nombres selon le sens", () => {
  const rows = [{ v: 3 }, { v: 1 }, { v: 2 }];
  assert.deepEqual(
    applyTableState({ sort: "v", dir: 1, filter: "" }, rows, []).map((r) => r.v),
    [1, 2, 3],
  );
  assert.deepEqual(
    applyTableState({ sort: "v", dir: -1, filter: "" }, rows, []).map((r) => r.v),
    [3, 2, 1],
  );
});

test("applyTableState place toujours les valeurs absentes en bas", () => {
  const rows = [{ v: 2 }, { v: null }, { v: 1 }];
  assert.deepEqual(
    applyTableState({ sort: "v", dir: 1, filter: "" }, rows, []).map((r) => r.v),
    [1, 2, null],
  );
  // Même en tri descendant, le null reste en bas (pas remonté).
  assert.deepEqual(
    applyTableState({ sort: "v", dir: -1, filter: "" }, rows, []).map((r) => r.v),
    [2, 1, null],
  );
});

test("applyTableState trie les chaînes par localeCompare", () => {
  const rows = [{ name: "banane" }, { name: "abricot" }, { name: "cerise" }];
  assert.deepEqual(
    applyTableState({ sort: "name", dir: 1, filter: "" }, rows, []).map((r) => r.name),
    ["abricot", "banane", "cerise"],
  );
});

test("applyTableState trie les booléens (false avant true en ascendant)", () => {
  const rows = [{ b: true }, { b: false }, { b: true }];
  assert.deepEqual(
    applyTableState({ sort: "b", dir: 1, filter: "" }, rows, []).map((r) => r.b),
    [false, true, true],
  );
});

test("applyTableState ne mute pas le tableau d'entrée", () => {
  const rows = [{ v: 2 }, { v: 1 }];
  applyTableState({ sort: "v", dir: 1, filter: "" }, rows, []);
  assert.deepEqual(
    rows.map((r) => r.v),
    [2, 1],
  ); // ordre d'origine préservé
});

// ---------------------------------------------------------------------------
// thSort — en-tête de colonne triable
// ---------------------------------------------------------------------------

test("thSort marque la colonne active avec la bonne flèche", () => {
  assert.match(thSort({ sort: "ratio", dir: 1 }, "ratio", "Ratio"), /class="sortable sorted".*▲/);
  assert.match(thSort({ sort: "ratio", dir: -1 }, "ratio", "Ratio"), /▼/);
});

test("thSort n'ajoute ni flèche ni « sorted » sur une colonne inactive", () => {
  const th = thSort({ sort: "ratio", dir: 1 }, "pledge", "Pledge");
  assert.doesNotMatch(th, /sorted/);
  assert.doesNotMatch(th, /▲|▼/);
  assert.match(th, /data-col="pledge"/);
});

test("thSort échappe le title (infobulle)", () => {
  const th = thSort({ sort: null, dir: 1 }, "ratio", "Ratio", 'valeur "brute"');
  assert.match(th, /title="valeur &quot;brute&quot;"/);
});
