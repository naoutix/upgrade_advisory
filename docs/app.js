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
//   candidates()    → calcule les upgrades possibles (règle CCU : cible
//                     strictement plus chère) et les classe en 4 groupes
//   renderTables()  → affiche les 4 tableaux, avec tri/filtre par tableau
//
// Sécurité : tout ce qui vient de data.json (noms de vaisseaux, de packs,
// de terminaux, URLs wiki) provient de sources externes — dont un wiki
// publiquement éditable — et passe donc par esc() avant toute insertion
// via innerHTML.

"use strict";

/* ---------------------------------------------------------------------------
 * Utilitaires
 * ------------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

/** Échappe une valeur pour insertion sûre dans du HTML (texte ou attribut). */
const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Nombre entier au format français : 1 234 567. */
const fmtN = (n) => n.toLocaleString("fr-FR", { maximumFractionDigits: 0 });

/** Prix en dollars : $1,234.50 (au plus 2 décimales). */
const fmtUsd = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

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

/** "07 juillet 2026 à 15:50" à partir d'un timestamp ISO. */
function formatFreshness(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "date inconnue";
  const dateStr = d.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
  const timeStr = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return `${dateStr} à ${timeStr}`;
}

/* ---------------------------------------------------------------------------
 * Chargement des données
 * ------------------------------------------------------------------------- */

async function loadData() {
  setStatus("loading", "Chargement des données en direct (pledge store officiel, UEX, wiki communautaire)…");
  try {
    const res = await fetch("./data.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    SHIPS = data.ships || [];
    META = data.meta || {};
    pledgedShips = SHIPS.filter((s) => s.pledge != null);

    $("metaLine").textContent = `${SHIPS.length} vaisseaux suivis`;
    $("rsiNote").innerHTML =
      (META.storefrontOk ? "" : ' <span class="warn">— le catalogue officiel était indisponible au dernier rafraîchissement, données partiellement en repli.</span>')
      + (META.conciergeWikiOk ? "" : ' <span class="warn">— le wiki des packs Concierge était indisponible, ceux-ci ne sont pas détectés.</span>');

    setStatus("ok", `<b>À jour</b> — dernières données du ${formatFreshness(META.generatedAt)}, vérifiées automatiquement chaque jour.`);

    renderList("");
    renderTables();
  } catch (err) {
    setStatus("error", `Impossible de charger les données à jour (${esc(err.message)}). Réessaie de recharger la page dans quelques instants.`);
  }
}

/* ---------------------------------------------------------------------------
 * Étiquettes de statut (En vente / Pack / Pas en vente / Concept)
 * ------------------------------------------------------------------------- */

/**
 * Un vaisseau vendu uniquement dans un pack Concierge est traité comme
 * "Pas en vente" tant que la case Mode Concierge n'est pas cochée : la
 * plupart des joueurs ne voient tout simplement pas ces packs.
 */
function isHiddenConcierge(s) {
  return s.packageOnly && s.packConcierge && !$("conciergeMode").checked;
}

function packTag(s) {
  return `<span class="tag pk">${s.packName ? "Pack : " + esc(s.packName) : "Pack"}${s.packConcierge ? " (Concierge)" : ""}</span>`;
}

/**
 * Rang de tri du statut pledge store : 0 = En vente, 1 = Pack,
 * 2 = Pas en vente. Reflète exactement ce que tagsOf() affiche.
 */
function statusRank(s) {
  if (isHiddenConcierge(s)) return 2;
  if (s.packageOnly) return 1;
  if (s.available) return 0;
  return 2;
}

function tagsOf(s, showConcept = true) {
  const t = [];
  if (isHiddenConcierge(s)) t.push('<span class="tag na">Pas en vente</span>');
  else if (s.packageOnly) t.push(packTag(s));
  else if (s.available) t.push('<span class="tag av">En vente</span>');
  else t.push('<span class="tag na">Pas en vente</span>');
  if (showConcept && s.concept) t.push('<span class="tag cc">Concept</span>');
  return t.join("");
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
    b.onclick = () => { selected = s; renderList($("search").value); renderCurrent(); renderTables(); };
    box.appendChild(b);
  }
}

/* ---------------------------------------------------------------------------
 * Fiche du vaisseau sélectionné
 * ------------------------------------------------------------------------- */

function renderCurrent() {
  const el = $("current");
  if (!selected) { el.hidden = true; return; }
  el.hidden = false;
  const s = selected;
  el.innerHTML = `
    <div class="name"><a href="${esc(s.wikiUrl)}" target="_blank" rel="noopener">${esc(s.name)}</a></div>
    <div class="tags">${tagsOf(s)}</div>
    <div class="stats">
      <div class="stat"><div class="l">Pledge</div><div class="v amber mono">${fmtUsd(s.pledge)}</div></div>
      <div class="stat"><div class="l">Prix en jeu</div>
        <div class="v mono">${s.auec != null ? fmtN(s.auec) : "—"}</div>
        <div class="d">${s.loc ? esc(s.loc) : "non vendu en jeu"}</div></div>
      <div class="stat" style="grid-column:1/-1"><div class="l">Ratio actuel</div>
        <div class="v teal mono">${s.ratio != null ? fmtN(s.ratio) + " aUEC/$" : "—"}</div></div>
    </div>
    <div class="hint">Objectif : trouver un vaisseau plus cher en pledge avec un meilleur ratio.</div>`;
}

/* ---------------------------------------------------------------------------
 * Calcul des candidats à l'upgrade
 * ------------------------------------------------------------------------- */

/**
 * Retourne les vaisseaux éligibles à un upgrade depuis `selected`, répartis
 * en 4 groupes correspondant aux 4 tableaux de la page :
 *   avail    — achetables seuls dès maintenant (ratio calculable)
 *   pack     — vendus uniquement dans un pack visible (ratio calculable)
 *   unavail  — pas en vente actuellement (ratio calculable)
 *   noInGame — prix en jeu inconnu, donc pas de ratio (souvent Concept)
 *
 * Règle CCU : la cible doit coûter strictement plus cher que le vaisseau
 * de départ ; l'upgrade ne coûte alors que la différence (`cost`).
 * `marginal` = aUEC gagnés ÷ $ réellement dépensés pour CET upgrade.
 * `gain` = variation du ratio absolu par rapport au vaisseau actuel (%).
 */
function candidates() {
  if (!selected) return { avail: [], pack: [], unavail: [], noInGame: [] };
  const base = selected;
  const onlyBetter = $("onlyBetter").checked;
  const withRatio = [], noInGame = [];
  for (const s of SHIPS) {
    if (s === base || s.pledge == null) continue;
    if (s.pledge <= base.pledge) continue; // règle CCU
    const cost = s.pledge - base.pledge;
    if (s.ratio == null) { // pas de prix en jeu connu
      noInGame.push({ ...s, cost });
      continue;
    }
    if (onlyBetter && base.ratio != null && s.ratio <= base.ratio) continue;
    const marginal = base.auec != null ? (s.auec - base.auec) / cost : s.auec / cost;
    withRatio.push({ ...s, cost, marginal, gain: base.ratio != null ? (s.ratio / base.ratio - 1) * 100 : null });
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
    avail: withRatio.filter((r) => r.available && !r.packageOnly),
    pack: withRatio.filter((r) => r.packageOnly && (conciergeMode || !r.packConcierge)),
    unavail: withRatio.filter((r) => (!r.available && !r.packageOnly)
      || (r.packageOnly && r.packConcierge && !conciergeMode)),
    noInGame,
  };
}

/* ---------------------------------------------------------------------------
 * Tri et filtre par tableau
 * ------------------------------------------------------------------------- */

/** Clé logique de chaque tableau → id de son conteneur dans le DOM. */
const TABLE_IDS = { avail: "tblAvail", pack: "tblPack", unavail: "tblUnavail", noInGame: "tblNoInGame" };

/** État de tri (colonne + sens) et de filtre texte, indépendant par tableau. */
const tableState = {
  avail: { sort: null, dir: 1, filter: "" },
  pack: { sort: null, dir: 1, filter: "" },
  unavail: { sort: null, dir: 1, filter: "" },
  noInGame: { sort: "status", dir: 1, filter: "" }, // groupe par défaut : En vente, Pack, Pas en vente
};

function sortTable(key, col) {
  const st = tableState[key];
  if (st.sort === col) st.dir *= -1; // re-clic sur la même colonne : inverse le sens
  else { st.sort = col; st.dir = 1; }
  renderTables();
}

function setFilter(key, value) {
  tableState[key].filter = (value || "").trim().toLowerCase();
  renderTables();
}

/** Applique filtre puis tri de `tableState[key]` aux lignes d'un tableau. */
function applyTableState(key, rows, filterFields) {
  const st = tableState[key];
  let out = rows;
  if (st.filter) {
    out = out.filter((r) => filterFields.some((f) => String(r[f] ?? "").toLowerCase().includes(st.filter)));
  }
  if (st.sort) {
    const col = st.sort, dir = st.dir;
    out = [...out].sort((a, b) => {
      let va = a[col], vb = b[col];
      if (va == null && vb == null) return 0;
      if (va == null) return 1; // valeurs absentes toujours en bas
      if (vb == null) return -1;
      if (typeof va === "boolean") { va = va ? 1 : 0; vb = vb ? 1 : 0; }
      if (typeof va === "string") return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
  }
  return out;
}

/**
 * En-tête de colonne triable. Le clic est géré par délégation dans init()
 * (data-col + un seul listener par tableau) : aucun JS inline, ce qui permet
 * la Content-Security-Policy stricte déclarée dans index.html.
 */
function thSort(key, col, label, title = "") {
  const st = tableState[key];
  const active = st.sort === col;
  const arrow = active ? (st.dir === 1 ? " ▲" : " ▼") : "";
  const titleAttr = title ? ` title="${esc(title)}"` : "";
  return `<th class="sortable${active ? " sorted" : ""}"${titleAttr} data-col="${col}">${label}${arrow}</th>`;
}

/* ---------------------------------------------------------------------------
 * Rendu des tableaux
 * ------------------------------------------------------------------------- */

/** Tableau des candidats avec ratio calculable (groupes avail/pack/unavail). */
function ratioTable(key, rows, opts = {}) {
  rows = applyTableState(key, rows, opts.showPack ? ["name", "packName"] : ["name"]);
  if (!rows.length) return '<div class="none">Aucun vaisseau ne remplit les critères.</div>';
  const maxRatio = Math.max(...rows.map((r) => r.ratio));
  const tr = rows.map((r) => `
    <tr>
      <td class="ship"><a href="${esc(r.wikiUrl)}" target="_blank" rel="noopener">${esc(r.name)}</a></td>
      <td class="${r.concept ? "blu" : "pos"}">${r.concept ? "Concept" : "Fly Ready"}</td>
      ${opts.showPack ? `<td>${packTag(r)}</td>` : ""}
      <td class="mono amb">${fmtUsd(r.pledge)}</td>
      <td class="mono">+${fmtUsd(r.cost)}</td>
      <td class="mono">${fmtN(r.auec)}<span class="loc">${esc(r.loc)}</span></td>
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
      ${thSort(key, "ratio", "Ratio absolu (aUEC/$)", "Valeur du vaisseau cible ÷ son prix complet — comme si tu l'achetais neuf")}
      ${thSort(key, "gain", "Gain ratio")}
      ${thSort(key, "marginal", "Rendement de l'upgrade (aUEC/$)", "Ce que rapporte précisément CET upgrade : aUEC gagnés ÷ $ réellement dépensés")}
    </tr></thead><tbody>${tr}</tbody></table>`;
}

/** Tableau des candidats sans prix en jeu connu (groupe noInGame). */
function noInGameTable(key, rows) {
  rows = rows.map((r) => ({ ...r, status: statusRank(r) }));
  rows = applyTableState(key, rows, ["name"]);
  if (!rows.length) return '<div class="none">Aucun vaisseau ne remplit les critères.</div>';
  const tr = rows.map((r) => `
    <tr>
      <td class="ship"><a href="${esc(r.wikiUrl)}" target="_blank" rel="noopener">${esc(r.name)}</a></td>
      <td class="${r.concept ? "blu" : "pos"}">${r.concept ? "Concept" : "Fly Ready"}</td>
      <td>${tagsOf(r, false)}</td>
      <td class="mono amb">${fmtUsd(r.pledge)}</td>
      <td class="mono">+${fmtUsd(r.cost)}</td>
    </tr>`).join("");
  return `<table>
    <thead><tr>
      ${thSort(key, "name", "Vaisseau")}${thSort(key, "concept", "Concept")}${thSort(key, "status", "Statut pledge store")}
      ${thSort(key, "pledge", "Pledge")}${thSort(key, "cost", "Coût upgrade")}
    </tr></thead><tbody>${tr}</tbody></table>`;
}

function renderTables() {
  if (!selected) {
    for (const id of Object.values(TABLE_IDS)) {
      $(id).innerHTML = SHIPS.length
        ? '<div class="none">Sélectionne d’abord ton vaisseau à gauche.</div>'
        : '<div class="none">En attente des données…</div>';
    }
    for (const id of ["cAvail", "cPack", "cUnavail", "cNoInGame"]) $(id).textContent = "";
    return;
  }
  const c = candidates();
  $("tblAvail").innerHTML = ratioTable("avail", c.avail);
  $("tblPack").innerHTML = ratioTable("pack", c.pack, { showPack: true });
  $("tblUnavail").innerHTML = ratioTable("unavail", c.unavail);
  $("tblNoInGame").innerHTML = noInGameTable("noInGame", c.noInGame);
  $("cAvail").textContent = "· " + c.avail.length;
  $("cPack").textContent = "· " + c.pack.length;
  $("cUnavail").textContent = "· " + c.unavail.length;
  $("cNoInGame").textContent = "· " + c.noInGame.length;
}

/* ---------------------------------------------------------------------------
 * Initialisation
 * ------------------------------------------------------------------------- */

function init() {
  $("search").addEventListener("input", (e) => renderList(e.target.value));
  $("onlyBetter").addEventListener("change", renderTables);
  $("sortBy").addEventListener("change", renderTables);
  $("conciergeMode").addEventListener("change", () => { renderCurrent(); renderTables(); });
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
