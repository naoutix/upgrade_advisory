const $ = (id) => document.getElementById(id);
const fmtN = (n) => n.toLocaleString("fr-FR", { maximumFractionDigits: 0 });
const fmtUsd = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

let SHIPS = [];
let META = {};
let owned = [];
let selected = null;

/* ------- bandeau de statut / fraîcheur des données ------- */
function setStatus(state, html) {
  const bar = $("statusBar");
  bar.className = state;
  $("statusText").innerHTML = html;
}

function formatFreshness(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "date inconnue";
  const dateStr = d.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
  const timeStr = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return `${dateStr} à ${timeStr}`;
}

async function loadData() {
  setStatus("loading", "Chargement des données en direct (pledge store officiel, UEX, wiki communautaire)…");
  try {
    const res = await fetch("./data.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    SHIPS = data.ships || [];
    META = data.meta || {};
    owned = SHIPS.filter((s) => s.pledge != null);

    $("metaLine").textContent = `${SHIPS.length} vaisseaux suivis`;
    $("rsiNote").innerHTML =
      (META.storefrontOk ? "" : ' <span class="warn">— le catalogue officiel était indisponible au dernier rafraîchissement, données partiellement en repli.</span>')
      + (META.conciergeWikiOk ? "" : ' <span class="warn">— le wiki des packs Concierge était indisponible, ceux-ci ne sont pas détectés.</span>');

    setStatus("ok", `<b>À jour</b> — actualisé automatiquement le ${formatFreshness(META.generatedAt)} (toutes les quelques heures).`);

    renderList("");
    renderTables();
  } catch (err) {
    setStatus("error", `Impossible de charger les données à jour (${err.message}). Réessaie de recharger la page dans quelques instants.`);
  }
}

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
  const items = owned.filter((s) => s.name.toLowerCase().includes(f));
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
  if (!selected) return { avail: [], pack: [], unavail: [], noInGame: [] };
  const base = selected;
  const onlyBetter = $("onlyBetter").checked;
  const withRatio = [], noInGame = [];
  for (const s of SHIPS) {
    if (s === base || s.pledge == null) continue;
    if (s.pledge <= base.pledge) continue; // règle CCU
    const cost = s.pledge - base.pledge;
    if (s.ratio == null) { // pas de prix en jeu
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

/* ------- tri et filtre par tableau ------- */
const tableState = {
  avail: { sort: null, dir: 1, filter: "" },
  pack: { sort: null, dir: 1, filter: "" },
  unavail: { sort: null, dir: 1, filter: "" },
  noInGame: { sort: null, dir: 1, filter: "" },
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
    out = out.filter((r) => filterFields.some((f) => String(r[f] ?? "").toLowerCase().includes(st.filter)));
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
  const maxRatio = Math.max(...rows.map((r) => r.ratio));
  const tr = rows.map((r) => `
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
      ${thSort(key, "ratio", "Ratio absolu (aUEC/$)", "Valeur du vaisseau cible ÷ son prix complet — comme si tu l'achetais neuf")}
      ${thSort(key, "gain", "Gain ratio")}
      ${thSort(key, "marginal", "Rendement de l'upgrade (aUEC/$)", "Ce que rapporte précisément CET upgrade : aUEC gagnés ÷ $ réellement dépensés")}
    </tr></thead><tbody>${tr}</tbody></table>`;
}

function noInGameTable(key, rows) {
  rows = applyTableState(key, rows, ["name"]);
  if (!rows.length) return '<div class="none">Aucun vaisseau ne remplit les critères.</div>';
  const tr = rows.map((r) => `
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
    for (const id of ["tblAvail", "tblPack", "tblUnavail", "tblNoInGame"]) {
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

$("search").addEventListener("input", (e) => renderList(e.target.value));
$("onlyBetter").addEventListener("change", renderTables);
$("sortBy").addEventListener("change", renderTables);
$("conciergeMode").addEventListener("change", () => { renderCurrent(); renderTables(); });
$("filterAvail").addEventListener("input", (e) => setFilter("avail", e.target.value));
$("filterPack").addEventListener("input", (e) => setFilter("pack", e.target.value));
$("filterUnavail").addEventListener("input", (e) => setFilter("unavail", e.target.value));
$("filterNoInGame").addEventListener("input", (e) => setFilter("noInGame", e.target.value));

renderTables();
loadData();
