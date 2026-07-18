// Pledge Fair — Upgrade Advisor (front-end).
//
// Application 100 % statique : au chargement, elle lit ./data.json (généré
// chaque jour par scripts/update-data.mjs via une GitHub Action — voir le
// README) et fait tout le reste côté navigateur. Aucune requête vers UEX,
// RSI ou le wiki n'est faite ici : le navigateur en serait de toute façon
// empêché par CORS, et c'est précisément le rôle du script serveur.
//
// Vue d'ensemble du flux :
//   loadData()  → charge data.json, remplit SHIPS/META
//   renderList()    → colonne de gauche : choisir son vaisseau actuel
//   renderCurrent() → fiche du vaisseau sélectionné
//   candidates()    → lit l'état de l'UI puis délègue à computeCandidates()
//                     ou, sans sélection, à computeCatalog()
//   renderTables()  → affiche les 4 tableaux, avec tri/filtre par tableau
//
// Deux modes : sans vaisseau sélectionné, la page montre tout le catalogue
// (mêmes groupes, sans les colonnes propres à l'upgrade) ; avec une sélection,
// elle ne montre que les upgrades possibles et leur coût.
//
// Toute la logique déterministe (échappement, formatage, calcul des
// candidats, tri/filtre) vit dans core.js, testée sans navigateur
// (core.test.mjs). Ce fichier ne garde que ce qui touche au DOM. Il est
// chargé comme module ES (<script type="module"> dans index.html), même
// origine : compatible avec la Content-Security-Policy stricte.

import {
  esc,
  fmtN,
  fmtUsd,
  formatFreshness,
  packTag,
  statusRank,
  tagsOf,
  computeCandidates,
  computeCatalog,
  applyTableState,
  thSort,
} from "./core.js";

/* ---------------------------------------------------------------------------
 * Utilitaires DOM
 * ------------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------------------
 * État global
 * ------------------------------------------------------------------------- */

/** Tous les vaisseaux de data.json (voir buildDataset() côté serveur). */
let SHIPS = [];
/** Métadonnées de data.json : date de génération, disponibilité des sources. */
let META = {};
/** Vaisseaux sélectionnables comme point de départ (prix pledge connu). */
let pledgedShips = [];
/** Vaisseau actuellement sélectionné, ou null. */
let selected = null;

/* ---------------------------------------------------------------------------
 * Bandeau de statut / fraîcheur des données
 * ------------------------------------------------------------------------- */

function setStatus(state, html) {
  $("statusBar").className = state; // loading | ok | error (voir style.css)
  $("statusText").innerHTML = html;
}

/* ---------------------------------------------------------------------------
 * Chargement des données
 * ------------------------------------------------------------------------- */

async function loadData() {
  setStatus(
    "loading",
    "Chargement des données en direct (pledge store officiel, UEX, wiki communautaire)…",
  );
  try {
    const res = await fetch("./data.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    SHIPS = data.ships || [];
    META = data.meta || {};
    pledgedShips = SHIPS.filter((s) => s.pledge != null);

    $("metaLine").textContent = `${SHIPS.length} vaisseaux suivis`;
    $("rsiNote").innerHTML =
      (META.storefrontOk
        ? ""
        : ' <span class="warn">— le catalogue officiel était indisponible au dernier rafraîchissement, données partiellement en repli.</span>') +
      (META.conciergeWikiOk
        ? ""
        : ' <span class="warn">— le wiki des packs Concierge était indisponible, ceux-ci ne sont pas détectés.</span>');

    setStatus(
      "ok",
      `<b>À jour</b> — dernières données du ${formatFreshness(META.generatedAt)}, vérifiées automatiquement chaque jour.`,
    );

    renderList("");
    renderTables();
  } catch (err) {
    setStatus(
      "error",
      `Impossible de charger les données à jour (${esc(err.message)}). Réessaie de recharger la page dans quelques instants.`,
    );
  }
}

/* ---------------------------------------------------------------------------
 * Colonne de gauche : liste de sélection du vaisseau actuel
 * ------------------------------------------------------------------------- */

function renderList(filter) {
  const box = $("shipList");
  box.innerHTML = "";
  const f = (filter || "").trim().toLowerCase();
  const items = pledgedShips.filter((s) => s.name.toLowerCase().includes(f));
  if (!items.length) {
    box.innerHTML = '<div class="empty">Aucun vaisseau ne correspond.</div>';
    return;
  }
  for (const s of items) {
    const b = document.createElement("button");
    b.setAttribute("role", "option");
    if (selected && selected.name === s.name) b.className = "sel";
    b.innerHTML = `<span>${esc(s.name)}</span><span class="p mono">${fmtUsd(s.pledge)}</span>`;
    // Re-cliquer le vaisseau déjà sélectionné le désélectionne → catalogue.
    b.onclick = () => selectShip(selected && selected.name === s.name ? null : s);
    box.appendChild(b);
  }
}

/* ---------------------------------------------------------------------------
 * Fiche du vaisseau sélectionné
 * ------------------------------------------------------------------------- */

function renderCurrent() {
  const el = $("current");
  if (!selected) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const s = selected;
  el.innerHTML = `
    <div class="name"><a href="${esc(s.wikiUrl)}" target="_blank" rel="noopener">${esc(s.name)}</a></div>
    <div class="tags">${tagsOf(s, $("conciergeMode").checked)}</div>
    <div class="stats">
      <div class="stat"><div class="l">Pledge</div><div class="v amber mono">${fmtUsd(s.pledge)}</div></div>
      <div class="stat"><div class="l">Prix en jeu</div>
        <div class="v mono">${s.auec != null ? fmtN(s.auec) : "—"}</div>
        <div class="d">${s.loc ? esc(s.loc) : "non vendu en jeu"}</div></div>
      <div class="stat full"><div class="l">Ratio actuel</div>
        <div class="v teal mono">${s.ratio != null ? fmtN(s.ratio) + " aUEC/$" : "—"}</div></div>
    </div>
    <div class="hint">Objectif : trouver un vaisseau plus cher en pledge avec un meilleur ratio.</div>`;
}

/* ---------------------------------------------------------------------------
 * Calcul des candidats à l'upgrade (lecture de l'UI → core.js)
 * ------------------------------------------------------------------------- */

function candidates() {
  const sortBy = $("sortBy").value;
  const conciergeMode = $("conciergeMode").checked;
  // Sans vaisseau de départ : mode catalogue, on montre tout (mêmes groupes,
  // mais aucune colonne propre à l'upgrade — il n'y a rien à comparer).
  if (!selected) return computeCatalog(SHIPS, { sortBy, conciergeMode });
  return computeCandidates(SHIPS, selected, {
    onlyBetter: $("onlyBetter").checked,
    sortBy,
    conciergeMode,
  });
}

/* ---------------------------------------------------------------------------
 * Tri et filtre par tableau
 * ------------------------------------------------------------------------- */

/** Clé logique de chaque tableau → id de son conteneur dans le DOM. */
const TABLE_IDS = {
  avail: "tblAvail",
  pack: "tblPack",
  unavail: "tblUnavail",
  noInGame: "tblNoInGame",
};

/** État de tri (colonne + sens) et de filtre texte, indépendant par tableau. */
const tableState = {
  avail: { sort: null, dir: 1, filter: "" },
  pack: { sort: null, dir: 1, filter: "" },
  unavail: { sort: null, dir: 1, filter: "" },
  noInGame: { sort: "status", dir: 1, filter: "" }, // groupe par défaut : En vente, Pack, Pas en vente
};

function sortTable(key, col) {
  const st = tableState[key];
  if (st.sort === col)
    st.dir *= -1; // re-clic sur la même colonne : inverse le sens
  else {
    st.sort = col;
    st.dir = 1;
  }
  renderTables();
}

function setFilter(key, value) {
  tableState[key].filter = (value || "").trim().toLowerCase();
  renderTables();
}

/* ---------------------------------------------------------------------------
 * Rendu des tableaux
 * ------------------------------------------------------------------------- */

/**
 * Tableau des vaisseaux avec ratio calculable (groupes avail/pack/unavail).
 * En mode catalogue (`opts.catalog`), les colonnes propres à l'upgrade — coût,
 * gain de ratio, rendement marginal — sont omises : elles n'ont de sens que
 * relativement à un vaisseau de départ.
 */
function ratioTable(key, rows, opts = {}) {
  const st = tableState[key];
  const upgrade = !opts.catalog;
  rows = applyTableState(st, rows, opts.showPack ? ["name", "packName"] : ["name"]);
  if (!rows.length) return '<div class="none">Aucun vaisseau ne remplit les critères.</div>';
  const maxRatio = Math.max(...rows.map((r) => r.ratio));
  const tr = rows
    .map(
      (r) => `
    <tr>
      <td class="ship"><a href="${esc(r.wikiUrl)}" target="_blank" rel="noopener">${esc(r.name)}</a></td>
      <td class="${r.concept ? "blu" : "pos"}">${r.concept ? "Concept" : "Fly Ready"}</td>
      ${opts.showPack ? `<td>${packTag(r)}</td>` : ""}
      <td class="mono amb">${fmtUsd(r.pledge)}</td>
      ${upgrade ? `<td class="mono">+${fmtUsd(r.cost)}</td>` : ""}
      <td class="mono">${fmtN(r.auec)}<span class="loc">${esc(r.loc)}</span></td>
      <td class="mono pos">${fmtN(r.ratio)}<span class="gainbar" data-w="${((r.ratio / maxRatio) * 90).toFixed(0)}"></span></td>
      ${
        upgrade
          ? `<td class="mono ${r.gain == null ? "" : r.gain >= 0 ? "pos" : "neg"}">${r.gain == null ? "—" : (r.gain >= 0 ? "+" : "") + r.gain.toFixed(0) + " %"}</td>
      <td class="mono">${fmtN(r.marginal)}</td>`
          : ""
      }
    </tr>`,
    )
    .join("");
  return `<table>
    <thead><tr>
      ${thSort(st, "name", "Vaisseau")}${thSort(st, "concept", "Concept")}
      ${opts.showPack ? thSort(st, "packName", "Statut pledge store") : ""}
      ${thSort(st, "pledge", "Pledge")}${upgrade ? thSort(st, "cost", "Coût upgrade") : ""}
      ${thSort(st, "auec", "Prix en jeu (aUEC)")}
      ${thSort(st, "ratio", "Ratio absolu (aUEC/$)", "Valeur du vaisseau ÷ son prix complet — comme si tu l'achetais neuf")}
      ${
        upgrade
          ? thSort(st, "gain", "Gain ratio") +
            thSort(
              st,
              "marginal",
              "Rendement de l'upgrade (aUEC/$)",
              "Ce que rapporte précisément CET upgrade : aUEC gagnés ÷ $ réellement dépensés",
            )
          : ""
      }
    </tr></thead><tbody>${tr}</tbody></table>`;
}

/** Tableau des candidats sans prix en jeu connu (groupe noInGame). */
function noInGameTable(key, rows, opts = {}) {
  const st = tableState[key];
  const upgrade = !opts.catalog;
  const conciergeMode = $("conciergeMode").checked;
  rows = rows.map((r) => ({ ...r, status: statusRank(r, conciergeMode) }));
  rows = applyTableState(st, rows, ["name"]);
  if (!rows.length) return '<div class="none">Aucun vaisseau ne remplit les critères.</div>';
  const tr = rows
    .map(
      (r) => `
    <tr>
      <td class="ship"><a href="${esc(r.wikiUrl)}" target="_blank" rel="noopener">${esc(r.name)}</a></td>
      <td class="${r.concept ? "blu" : "pos"}">${r.concept ? "Concept" : "Fly Ready"}</td>
      <td>${tagsOf(r, conciergeMode, false)}</td>
      <td class="mono amb">${fmtUsd(r.pledge)}</td>
      ${upgrade ? `<td class="mono">+${fmtUsd(r.cost)}</td>` : ""}
    </tr>`,
    )
    .join("");
  return `<table>
    <thead><tr>
      ${thSort(st, "name", "Vaisseau")}${thSort(st, "concept", "Concept")}${thSort(st, "status", "Statut pledge store")}
      ${thSort(st, "pledge", "Pledge")}${upgrade ? thSort(st, "cost", "Coût upgrade") : ""}
    </tr></thead><tbody>${tr}</tbody></table>`;
}

/**
 * Adapte les libellés au mode courant : catalogue (aucun vaisseau
 * sélectionné) ou upgrade (comparaison depuis le vaisseau sélectionné).
 */
function renderMode(catalog) {
  $("clearSelection").hidden = catalog;
  $("modeNote").innerHTML = catalog
    ? "<b>Catalogue complet</b> — tous les vaisseaux et leurs ratios. Sélectionne ton vaisseau à gauche pour ne voir que les upgrades possibles et leur coût."
    : "<b>Upgrades possibles</b> — uniquement les vaisseaux plus chers que le tien (règle du CCU).";
  // Les réglages propres à l'upgrade n'ont pas de sens sans vaisseau de départ.
  $("onlyBetter").disabled = catalog;
  $("onlyBetter").closest("label").classList.toggle("off", catalog);
  $("descAvail").textContent = catalog
    ? "Tous les vaisseaux achetables dès aujourd'hui, seuls, sur le site officiel. Clique un en-tête de colonne pour trier."
    : "Vaisseaux que tu peux acheter dès aujourd'hui, seuls, sur le site officiel. Clique un en-tête de colonne pour trier.";
  $("descNoInGame").textContent = catalog
    ? "Vaisseaux dont on ne connaît pas encore le prix en aUEC dans le jeu — souvent parce qu'ils n'existent pas encore en jeu (statut \"Concept\") ou qu'aucun vendeur ne les propose actuellement."
    : "Vaisseaux plus chers que le tien, mais dont on ne connaît pas encore le prix en aUEC dans le jeu — souvent parce qu'ils n'existent pas encore en jeu (statut \"Concept\") ou qu'aucun vendeur ne les propose actuellement.";
}

function renderTables() {
  const catalog = !selected;
  renderMode(catalog);
  if (!SHIPS.length) {
    for (const id of Object.values(TABLE_IDS)) {
      $(id).innerHTML = '<div class="none">En attente des données…</div>';
    }
    for (const id of ["cAvail", "cPack", "cUnavail", "cNoInGame"]) $(id).textContent = "";
    return;
  }
  const c = candidates();
  $("tblAvail").innerHTML = ratioTable("avail", c.avail, { catalog });
  $("tblPack").innerHTML = ratioTable("pack", c.pack, { catalog, showPack: true });
  $("tblUnavail").innerHTML = ratioTable("unavail", c.unavail, { catalog });
  $("tblNoInGame").innerHTML = noInGameTable("noInGame", c.noInGame, { catalog });
  // La largeur des barres de ratio est posée via l'API DOM (et non un
  // style="" inline dans le HTML généré), ce qui permet une CSP stricte sans
  // 'unsafe-inline' — l'attribut style parsé depuis le HTML serait bloqué,
  // pas une écriture programmatique sur element.style.
  for (const bar of document.querySelectorAll(".gainbar[data-w]")) {
    bar.style.width = bar.dataset.w + "px";
  }
  $("cAvail").textContent = "· " + c.avail.length;
  $("cPack").textContent = "· " + c.pack.length;
  $("cUnavail").textContent = "· " + c.unavail.length;
  $("cNoInGame").textContent = "· " + c.noInGame.length;
}

/* ---------------------------------------------------------------------------
 * Initialisation
 * ------------------------------------------------------------------------- */

/** Colonnes qui n'existent qu'en mode upgrade : un tri posé sur l'une d'elles
 * doit être oublié en repassant au catalogue, sinon le tableau serait trié sur
 * une colonne invisible (toutes valeurs absentes). */
const UPGRADE_COLS = ["cost", "gain", "marginal"];

function selectShip(ship) {
  selected = ship;
  if (!ship) {
    for (const st of Object.values(tableState)) {
      if (UPGRADE_COLS.includes(st.sort)) {
        st.sort = null;
        st.dir = 1;
      }
    }
  }
  renderList($("search").value);
  renderCurrent();
  renderTables();
}

function init() {
  $("search").addEventListener("input", (e) => renderList(e.target.value));
  $("clearSelection").addEventListener("click", () => selectShip(null));
  $("onlyBetter").addEventListener("change", renderTables);
  $("sortBy").addEventListener("change", renderTables);
  $("conciergeMode").addEventListener("change", () => {
    renderCurrent();
    renderTables();
  });
  $("filterAvail").addEventListener("input", (e) => setFilter("avail", e.target.value));
  $("filterPack").addEventListener("input", (e) => setFilter("pack", e.target.value));
  $("filterUnavail").addEventListener("input", (e) => setFilter("unavail", e.target.value));
  $("filterNoInGame").addEventListener("input", (e) => setFilter("noInGame", e.target.value));

  // Tri par clic sur les en-têtes : délégation sur chaque conteneur de
  // tableau (le contenu est régénéré à chaque rendu, pas les conteneurs).
  for (const [key, id] of Object.entries(TABLE_IDS)) {
    $(id).addEventListener("click", (e) => {
      const th = e.target.closest("th.sortable");
      if (th) sortTable(key, th.dataset.col);
    });
  }

  renderTables();
  loadData();
}

init();
