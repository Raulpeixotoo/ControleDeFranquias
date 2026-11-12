"use strict";
/* Solicitações das franquias (chamados): Kanban das abertas + lista das finalizadas.
   Depende de app.js / pipeline.js: S, api, esc, norm, $, $$, toast, load, show, fmtDate, ago, daysSince, kpi, bars, countBy, lastRev, user, isLive. */

let solMode = localStorage.getItem("cf_solmode") || "kanban", solDrag = false, solFin = [], solFinKey = "", solFinReady = false;
let solUnitMap = new Map(), solOrigEtapa = null;
const dayDiff = (a, b) => Math.max(0, Math.floor((new Date(b) - new Date(a)) / 864e5));
const unitLabel = u => `${u.nome} (${u.uf})${u.sigla ? " · " + u.sigla : ""}`;

function solMaps() {
  const X = S.sol;
  return { cat: Object.fromEntries(X.categorias.map(c => [c.id, c])), sub: Object.fromEntries(X.subcategorias.map(c => [c.id, c])),
    et: Object.fromEntries(X.etapas.map(c => [c.id, c])), un: Object.fromEntries(S.units.map(u => [u.id, u])) };
}
const solUnit = (it, m) => { const u = m.un[it.unidade_id]; return u ? `${u.nome} (${u.uf})` : (it.unidade_txt || ""); };
function jiraUrl(it) {
  const key = (it.jira || "").trim(), base = S.sol.jira_base;
  if (it.link) return it.link;
  return base && /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key) ? base.replace(/\/?$/, "/") + key : "";
}
function jiraHtml(it) {
  const url = jiraUrl(it), key = (it.jira || "").trim();
  if (url) return `<a class="jira" target="_blank" rel="noopener" href="${esc(url)}" title="Abrir chamado no Jira">${esc(key || "abrir chamado")} ${ic("external")}</a>`;
  return key ? `<span class="jira">${esc(key)}</span>` : "";
}

/* ---------- filtros ---------- */
function fillSolFilters() {
  const X = S.sol;
  fillSelect($("#fSolCat"), X.categorias, { first: "Todas as categorias", value: c => c.id, label: c => c.nome });
  const cat = $("#fSolCat").value, subs = X.subcategorias.filter(s => !cat || s.categoria_id == cat), cn = Object.fromEntries(X.categorias.map(c => [c.id, c.nome]));
  fillSelect($("#fSolSub"), subs, { first: "Todas as subcategorias", value: s => s.id, label: s => (cat ? "" : cn[s.categoria_id] + " › ") + s.nome });
  const resps = [...new Set([...X.abertas, ...solFin].map(i => i.responsavel).filter(Boolean))].sort();
  fillSelect($("#fSolResp"), resps, { first: "Todos os responsáveis", extra: [["__none", "Sem responsável"]] });
}
function solFilter(items, m) {
  const q = norm($("#fSolQ").value), cat = $("#fSolCat").value, sub = $("#fSolSub").value, resp = $("#fSolResp").value, pri = $("#fSolPri").value;
  return items.filter(it => (!cat || it.categoria_id == cat) && (!sub || it.subcategoria_id == sub) && (!pri || it.prioridade === pri) &&
    (!resp || (resp === "__none" ? !it.responsavel : it.responsavel === resp)) &&
    (!q || norm([it.titulo, it.jira, it.solicitante, it.responsavel, it.descricao, solUnit(it, m)].join(" ")).includes(q)));
}

/* ---------- kanban (abertas) ---------- */
function solCard(it, m) {
  const cat = m.cat[it.categoria_id], sub = m.sub[it.subcategoria_id], un = solUnit(it, m);
  const dias = dayDiff(it.criado_em, Date.now()), idle = dayDiff(it.atualizado_em, Date.now());
  return `<article class="sc" draggable="true" data-sol="${it.id}">
    <div class="sctags">${cat ? `<span class="tag" style="background:${esc(cat.cor)}">${esc(cat.nome)}</span>` : ""}${sub ? `<span class="tag sub">${esc(sub.nome)}</span>` : ""}<span class="spacer"></span>
      ${it.prioridade ? `<i class="sdot pri-${it.prioridade}" title="Prioridade ${PRI_LABEL[it.prioridade]}"></i>` : ""}</div>
    <div class="sctitle">${esc(it.titulo)}</div>
    ${un ? `<div class="scmeta">${ic("building")} ${esc(un)}</div>` : ""}
    <div class="scmeta">${ic("user")} ${esc(it.solicitante || "—")}${it.responsavel ? ` <span class="muted">→</span> ${esc(it.responsavel)}` : ""}</div>
    <div class="scfoot"><span class="age ${dias >= 15 ? "red" : dias >= 7 ? "amb" : ""}" title="Dias desde a abertura (até finalizar)">${ic("clock")} ${dias} d aberta</span>
      ${idle >= 3 ? `<span class="muted" title="Dias sem nenhuma atualização">· parada ${idle} d</span>` : ""}<span class="spacer"></span>${jiraHtml(it)}
      <button class="btn sm ghost" data-solfin="${it.id}" title="Finalizar">${ic("check")}</button></div></article>`;
}
function renderSolBoard(m) {
  const X = S.sol, items = solFilter(X.abertas, m), open = X.etapas.filter(e => !e.final), fin = X.etapas.filter(e => e.final);
  const stale = items.filter(i => dayDiff(i.atualizado_em, Date.now()) >= 5).length, old = items.filter(i => dayDiff(i.criado_em, Date.now()) >= 15).length;
  $("#solSummary").innerHTML = `<span class="badge b-baixa">${items.length} abertas</span> <span class="badge b-media">${stale} sem atualização há 5+ dias</span>
    <span class="badge b-alta">${old} abertas há 15+ dias</span> <span class="muted">· arraste o cartão entre as etapas; solte em “Finalizada” para encerrar</span>`;
  $("#solBoard").innerHTML = open.map(e => {
    const col = items.filter(i => i.etapa_id === e.id).sort((a, b) => priRankOf(a.prioridade) - priRankOf(b.prioridade) || a.criado_em.localeCompare(b.criado_em));
    return `<section class="scol" data-etapa="${e.id}"><h4>${esc(e.nome)} <span class="muted">(${col.length})</span></h4>
      <div class="scbody">${col.map(i => solCard(i, m)).join("") || `<div class="empty">—</div>`}</div></section>`;
  }).join("") + `<div class="sfins">${fin.map(e => `<div class="sfinish" data-final="${e.id}">${ic("check")} ${esc(e.nome)}<small>solte aqui</small></div>`).join("")}</div>`;
}

/* ---------- lista (finalizadas) ---------- */
function drawSolList(m) {
  const items = solFilter(solFin, m);
  if (!solFinReady) { $("#solList").innerHTML = `<div class="empty">Carregando…</div>`; return; }
  const dur = items.map(i => i.finalizado_em ? dayDiff(i.criado_em, i.finalizado_em) : null);
  const known = dur.filter(d => d !== null), avg = known.length ? (known.reduce((a, b) => a + b, 0) / known.length) : null;
  const med = known.length ? [...known].sort((a, b) => a - b)[Math.floor(known.length / 2)] : null;
  const byCat = new Map();
  items.forEach((i, k) => { if (dur[k] === null) return; const n = (m.cat[i.categoria_id] || {}).nome || "?"; const o = byCat.get(n) || { s: 0, n: 0 }; o.s += dur[k]; o.n++; byCat.set(n, o); });
  $("#solSummary").innerHTML = `<span class="badge b-ok">${items.length} finalizadas</span> <span class="badge b-baixa">média ${avg === null ? "—" : avg.toFixed(1).replace(".", ",")} dias até finalizar</span>
    <span class="badge b-none">mediana ${med === null ? "—" : med} d</span> ${items.length > known.length ? `<span class="badge b-none">${items.length - known.length} sem data de finalização (incluídas em todos os períodos; fora das médias)</span>` : ""} ${[...byCat].map(([n, o]) => `<span class="badge b-none">${esc(n)}: ${(o.s / o.n).toFixed(1).replace(".", ",")} d (${o.n})</span>`).join(" ")}`;
  $("#solList").innerHTML = items.length ? `<div class="gscroll" style="max-height:none"><table class="pg sl"><thead><tr><th>Nº</th><th>Finalizada em</th><th>Título</th><th>Categoria / subcategoria</th>
    <th>Unidade</th><th>Solicitante</th><th>Responsável</th><th>Aberta em</th><th>Dias até finalizar</th><th>Resultado</th><th>Jira</th></tr></thead><tbody>
    ${items.map((i, k) => `<tr data-sol="${i.id}" class="clk"><td>${i.id}</td><td>${fmtDate(i.finalizado_em)}</td><td class="tl">${esc(i.titulo)}</td>
      <td>${esc((m.cat[i.categoria_id] || {}).nome || "")}${m.sub[i.subcategoria_id] ? " › " + esc(m.sub[i.subcategoria_id].nome) : ""}</td><td>${esc(solUnit(i, m))}</td>
      <td>${esc(i.solicitante)}</td><td>${esc(i.responsavel)}</td><td>${fmtDate(i.criado_em)}</td><td style="text-align:right"><strong>${dur[k] === null ? "—" : dur[k]}</strong></td>
      <td>${esc(i.etapa_nome)}</td><td>${jiraHtml(i)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Nenhuma solicitação finalizada neste período.</div>`;
}

/* ---------- ranking por unidade ---------- */
let solRankKey = "", solRank = { rows: [], sem_unidade: 0 };
function drawSolRank() {
  const q = norm($("#fSolQ").value), rows = solRank.rows.filter(r => !q || norm(`${r.nome} ${r.sigla} ${r.uf} ${r.tipo}`).includes(q));
  const max = Math.max(1, ...rows.map(r => r.tot));
  $("#solSummary").innerHTML = `<span class="badge b-baixa">${rows.length} unidades</span> <span class="badge b-none">${rows.reduce((a, r) => a + r.tot, 0)} solicitações</span>
    ${solRank.sem_unidade ? `<span class="muted">· ${solRank.sem_unidade} sem unidade vinculada (não entram no ranking)</span>` : ""}`;
  $("#solRank").innerHTML = rows.length ? `<div class="gscroll" style="max-height:none"><table class="pg sl"><thead><tr><th>#</th><th>Unidade</th><th>UF</th><th>Tipo</th><th>Solicitações</th>
    <th>Abertas</th><th>Média p/ finalizar</th><th>Principais assuntos</th><th>Ocorrências abertas</th><th>Última</th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr class="clk" data-edit-unit="${r.id}"><td>${i + 1}</td><td class="tl"><strong>${esc(r.nome)}</strong>${r.sigla ? ` <span class="muted">${esc(r.sigla)}</span>` : ""}</td>
      <td>${esc(r.uf)}</td><td>${esc(r.tipo)}</td><td><span class="rbar"><i style="width:${r.tot / max * 100}%"></i></span> <strong>${r.tot}</strong></td>
      <td>${r.ab ? `<strong>${r.ab}</strong>` : "—"}</td><td>${r.media_dias === null ? "—" : String(r.media_dias).replace(".", ",") + " d"}</td>
      <td class="tl">${esc(r.top.join(", "))}</td><td>${r.ocorrencias_abertas || "—"}</td><td>${fmtDate(r.ultima)}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="empty">Nenhuma unidade com solicitações neste período.</div>`;
}
function renderSolRank() {
  const per = $("#fSolPer").value, cat = $("#fSolCat").value, key = `${per}|${cat}|${lastRev}`;
  if (solRankKey !== key) {
    solRankKey = key;
    api(`/sol/ranking?dias=${per}&cat=${cat}`).then(r => { solRank = r; drawSolRank(); }).catch(e => toast(esc(e.message)));
  }
  drawSolRank();
}

function renderSol() {
  const board = $("#solBoard"); if (!board) return;
  const X = S.sol, m = solMaps();
  $("#badgeSol").textContent = X.abertas.length; $("#badgeSol").dataset.n = X.abertas.length;
  $$("#solMode button").forEach(b => b.classList.toggle("active", b.dataset.smode === solMode));
  board.hidden = solMode !== "kanban"; $("#solList").hidden = solMode !== "lista"; $("#solRank").hidden = solMode !== "ranking";
  $("#fSolPer").hidden = solMode === "kanban";
  fillSolFilters();
  if (solMode === "kanban") { if (!solDrag) renderSolBoard(m); return; }
  if (solMode === "ranking") return renderSolRank();
  const key = $("#fSolPer").value + "|" + lastRev;
  if (solFinKey !== key) {
    solFinKey = key;
    api("/sol/finalizadas?dias=" + $("#fSolPer").value).then(r => { solFin = r.items; solFinReady = true; fillSolFilters(); drawSolList(solMaps()); }).catch(e => toast(esc(e.message)));
  }
  drawSolList(m);
}

/* ---------- widgets do painel ---------- */
function solKpi() {
  const a = S.sol.abertas, stale = a.filter(i => dayDiff(i.atualizado_em, Date.now()) >= 5).length;
  return kpi(a.length, "solicitações abertas", a.length ? `${stale} sem atualização há 5+ dias` : "nenhuma aberta", stale ? "warn" : "", "solicitacoes");
}
function solCatBars() {
  const m = solMaps(), rows = countBy(S.sol.abertas, i => (m.cat[i.categoria_id] || {}).nome).map(r => ({ ...r, attr: 'data-go="solicitacoes"' }));
  return rows.length ? bars(rows) : `<div class="empty">Nenhuma aberta</div>`;
}
function solOldList() {
  const m = solMaps(), list = [...S.sol.abertas].sort((a, b) => a.criado_em.localeCompare(b.criado_em)).slice(0, 6);
  return list.length ? `<div class="list">${list.map(i => `<div class="item" data-sol="${i.id}"><span class="badge ${dayDiff(i.criado_em, Date.now()) >= 15 ? "b-critica" : "b-media"}">${dayDiff(i.criado_em, Date.now())} d</span>
    <div class="main"><div class="t">${esc(i.titulo)}</div><div class="s">${esc((m.cat[i.categoria_id] || {}).nome || "")} · ${esc((m.et[i.etapa_id] || {}).nome || "")}${solUnit(i, m) ? " · " + esc(solUnit(i, m)) : ""}</div></div></div>`).join("")}</div>`
    : `<div class="empty">Nenhuma solicitação aberta</div>`;
}

function solUnidadesList() {
  const um = new Map(S.units.map(u => [String(u.id), u]));
  const rows = Object.entries(S.sol_units).map(([id, v]) => ({ u: um.get(id), ...v })).filter(r => r.u && r.d90 > 0).sort((a, b) => b.d90 - a.d90 || b.ab - a.ab).slice(0, 8);
  return rows.length ? `<div class="list">${rows.map(r => `<div class="item" data-edit-unit="${r.u.id}"><span class="badge b-baixa">${r.d90}</span>
    <div class="main"><div class="t">${esc(r.u.nome)}</div><div class="s">${esc(r.u.uf)} · ${r.ab ? `${r.ab} aberta(s) · ` : ""}${r.tot} no total</div></div></div>`).join("")}</div>`
    : `<div class="empty">Nenhuma solicitação vinculada a unidades nos últimos 90 dias</div>`;
}

/* ---------- criar / editar ---------- */
function fillFormSubs(selected) {
  const cat = $("#sCat").value, subs = S.sol.subcategorias.filter(s => s.categoria_id == cat);
  $("#sSub").innerHTML = `<option value="">—</option>` + subs.map(s => `<option value="${s.id}" ${s.id == selected ? "selected" : ""}>${esc(s.nome)}</option>`).join("");
}
function renderSolHist(hist) {
  $("#solHist").innerHTML = hist.length ? hist.map(h => `<div class="logrow"><span class="when" title="${esc(h.ts)}">${ago(h.ts)}</span>
    <span><strong>${esc(h.evento)}</strong>${h.detalhe ? " — " + esc(h.detalhe) : ""} <span class="muted">· ${esc(h.user)}</span></span></div>`).join("") : `<div class="muted">Sem histórico.</div>`;
}
async function openSol(id) {
  const X = S.sol; let it = null, hist = [];
  if (!X.categorias.length || !X.etapas.length) { toast("Configure categorias e etapas primeiro (botão Configurar)."); return; }
  if (id) { try { const r = await api("/sol/" + id); it = r.item; hist = r.hist; } catch (e) { toast(esc(e.message)); return; } }
  const f = $("#formSol"); f.dataset.id = id || ""; f.reset();
  $("#sCat").innerHTML = X.categorias.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join("");
  $("#sCat").value = it ? it.categoria_id : X.categorias[0].id;
  fillFormSubs(it ? it.subcategoria_id : null);
  solUnitMap = new Map(S.units.map(u => [unitLabel(u), u.id]));
  $("#solUnits").innerHTML = [...solUnitMap.keys()].map(l => `<option value="${esc(l)}">`).join("");
  const u = it && S.units.find(x => x.id === it.unidade_id);
  $("#sUn").value = it ? (u ? unitLabel(u) : it.unidade_txt) : "";
  $("#sTitulo").value = it ? it.titulo : ""; $("#sSol").value = it ? it.solicitante : ""; $("#sResp").value = it ? it.responsavel : user;
  $("#sJira").value = it ? it.jira : ""; $("#sLink").value = it ? it.link : "";
  $("#sCriado").value = it ? it.criado_em.slice(0, 10) : ""; $("#sFinal").value = it && it.finalizado_em ? it.finalizado_em.slice(0, 10) : ""; $("#sDesc").value = it ? it.descricao : "";
  $("#sPri").innerHTML = priOptions(it ? it.prioridade : "");
  const stages = it ? X.etapas : X.etapas.filter(e => !e.final);
  solOrigEtapa = it ? it.etapa_id : stages[0].id;
  $("#sEtapa").innerHTML = stages.map(e => `<option value="${e.id}" ${e.id === solOrigEtapa ? "selected" : ""}>${esc(e.nome)}${e.final ? " (finalizada)" : ""}</option>`).join("");
  const isFinal = it && it.etapa_final;
  $("#solTitle").textContent = it ? `Solicitação #${it.id}` : "Nova solicitação";
  $("#solMeta").textContent = it ? `aberta ${fmtDate(it.criado_em)} · ${isFinal ? (it.finalizado_em ? `finalizada ${fmtDate(it.finalizado_em)} — ${dayDiff(it.criado_em, it.finalizado_em)} dias até finalizar` : "finalizada · data de finalização não informada") : `${dayDiff(it.criado_em, Date.now())} dias aberta`}` : "";
  const url = it ? jiraUrl(it) : ""; $("#sOpen").hidden = !url; if (url) $("#sOpen").href = url;
  $("#solHistBox").hidden = !it; if (it) renderSolHist(hist);
  $("#btnSolDel").hidden = !it; $("#btnSolFin").hidden = !it || isFinal; $("#btnSolReopen").hidden = !it || !isFinal;
  $("#errSol").textContent = ""; $("#sNote").value = "";
  $("#dlgSol").showModal();
}
async function moveSol(id, etapaId) {
  solDrag = false;
  try { await api(`/sol/${id}/etapa`, "PUT", { etapa_id: etapaId }); } catch (e) { toast(esc(e.message)); }
  await load(true);
}
const firstEtapa = fin => S.sol.etapas.find(e => !!e.final === fin);
async function finishSol(id) {
  const e = firstEtapa(true); if (!e) return toast("Crie uma etapa de finalização em Configurar.");
  await moveSol(id, e.id); toast("Solicitação finalizada.");
}

/* ---------- configuracao ---------- */
function renderSolCfg() {
  const X = S.sol, scrollPos = $("#solCfgBody").scrollTop;
  const row = (kind, o, extra) => `<div class="cfgrow"><input data-scfg="${kind}" data-id="${o.id}" data-f="nome" value="${esc(o.nome)}">${extra || ""}
    <button class="btn sm ghost" data-scmv="${kind}" data-id="${o.id}" data-d="-1">↑</button><button class="btn sm ghost" data-scmv="${kind}" data-id="${o.id}" data-d="1">↓</button>
    <button class="btn sm danger ghost" data-scdel="${kind}" data-id="${o.id}">✕</button></div>`;
  $("#solCfgBody").innerHTML = `<h4>Etapas do pipeline (da esquerda para a direita)</h4>
    ${X.etapas.map(e => row("etapas", e, `<label class="chk" title="Etapa final: o cartão sai do Kanban e vai para a lista de finalizadas"><input type="checkbox" data-scfg="etapas" data-id="${e.id}" data-f="final" ${e.final ? "checked" : ""}> finaliza</label>`)).join("")}
    <div class="cfgrow"><input id="scNewEtapa" placeholder="Nova etapa…"><label class="chk"><input type="checkbox" id="scNewFinal"> finaliza</label><button class="btn sm" data-scadd="etapas">${ic("plus")} Etapa</button></div>
    <h4>Categorias e subcategorias</h4>
    ${X.categorias.map(c => `<div class="cfgfase">${row("categorias", c, `<input type="color" data-scfg="categorias" data-id="${c.id}" data-f="cor" value="${esc(c.cor)}" title="Cor da etiqueta">`)}
      <div style="margin-left:22px">${X.subcategorias.filter(s => s.categoria_id === c.id).map(s => row("subcategorias", s)).join("")}
      <div class="cfgrow"><input id="scNewSub${c.id}" placeholder="Nova subcategoria de ${esc(c.nome)}…"><button class="btn sm" data-scadd="subcategorias" data-cat="${c.id}">${ic("plus")} Subcategoria</button></div></div></div>`).join("")}
    <div class="cfgrow"><input id="scNewCat" placeholder="Nova categoria (ex.: Jira, Unidade…)"><input type="color" id="scNewCor" value="#2b5c85"><button class="btn sm" data-scadd="categorias">${ic("plus")} Categoria</button></div>
    <h4>Jira</h4><label>Endereço base (a chave, ex. FRQ-123, vira link) <input id="scJira" value="${esc(X.jira_base)}" placeholder="https://suaempresa.atlassian.net/browse/"></label>`;
  $("#solCfgBody").scrollTop = scrollPos;
}
async function scDo(fn) { try { await fn(); await load(true); } catch (e) { toast(esc(e.message)); } renderSolCfg(); }

/* ---------- eventos ---------- */
document.addEventListener("click", e => {
  const fin = e.target.closest("[data-solfin]"); if (fin) { finishSol(fin.dataset.solfin); return; }
  const mode = e.target.closest("#solMode button"); if (mode) { solMode = mode.dataset.smode; localStorage.setItem("cf_solmode", solMode); renderSol(); return; }
  if (e.target.closest("a")) return;
  const row = e.target.closest("[data-sol]");
  if (row && !(typeof editing !== "undefined" && editing && row.closest(".w"))) { openSol(row.dataset.sol); return; }
  const b = e.target.closest("button"); if (!b) return;
  switch (b.id) {
    case "btnSolNew": return openSol();
    case "btnSolCfg": renderSolCfg(); return $("#dlgSolCfg").showModal();
    case "btnSolFin": { const id = $("#formSol").dataset.id; $("#dlgSol").close(); return finishSol(id); }
    case "btnSolReopen": { const id = $("#formSol").dataset.id, e2 = firstEtapa(false); $("#dlgSol").close(); return e2 && moveSol(id, e2.id); }
    case "btnSolDel": {
      const id = $("#formSol").dataset.id; if (!confirm("Excluir esta solicitação e o histórico dela?")) return;
      api("/sol/" + id, "DELETE").then(() => { $("#dlgSol").close(); return load(true); }).catch(err => toast(esc(err.message))); return;
    }
    case "btnSolNote": {
      const id = $("#formSol").dataset.id, texto = $("#sNote").value.trim(); if (!texto) return;
      api(`/sol/${id}/nota`, "POST", { texto }).then(() => api("/sol/" + id)).then(r => { $("#sNote").value = ""; renderSolHist(r.hist); return load(true); }).catch(err => toast(esc(err.message))); return;
    }
  }
  if (!$("#dlgSolCfg").contains(b)) return;
  const kind = b.dataset.scadd || b.dataset.scdel || b.dataset.scmv, id = b.dataset.id;
  if (b.dataset.scadd) {
    return scDo(() => {
      if (kind === "etapas") return api("/solcfg/etapas", "POST", { nome: $("#scNewEtapa").value, final: $("#scNewFinal").checked ? 1 : 0 });
      if (kind === "categorias") return api("/solcfg/categorias", "POST", { nome: $("#scNewCat").value, cor: $("#scNewCor").value });
      return api("/solcfg/subcategorias", "POST", { nome: $("#scNewSub" + b.dataset.cat).value, categoria_id: b.dataset.cat });
    });
  }
  if (b.dataset.scdel) { if (!confirm("Excluir?")) return; return scDo(() => api(`/solcfg/${kind}/${id}`, "DELETE")); }
  if (b.dataset.scmv) {
    const arr = [...S.sol[kind]], i = arr.findIndex(x => x.id == id), d = +b.dataset.d;
    let j = i + d; while (j >= 0 && j < arr.length && kind === "subcategorias" && arr[j].categoria_id !== arr[i].categoria_id) j += d;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    return scDo(() => api(`/solcfg/${kind}/reorder`, "POST", { ids: arr.map(x => x.id) }));
  }
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.id === "sCat") return fillFormSubs(null);
  if (t.id === "scJira") return scDo(() => api("/settings", "PUT", { jira_base: t.value }));
  if (t.matches("#solCfgBody [data-scfg]")) {
    const v = t.type === "checkbox" ? (t.checked ? 1 : 0) : t.value;
    return scDo(() => api(`/solcfg/${t.dataset.scfg}/${t.dataset.id}`, "PUT", { [t.dataset.f]: v }));
  }
});
document.addEventListener("input", e => {
  if (e.target.id === "sJira" && /^https?:\/\//i.test(e.target.value.trim())) {          // colou a URL no campo da chave
    const url = e.target.value.trim(); $("#sLink").value = url; e.target.value = (url.match(/[A-Z][A-Z0-9_]+-\d+/g) || []).pop() || "";
  }
  if (["fSolQ", "fSolCat", "fSolSub", "fSolResp", "fSolPri", "fSolPer"].includes(e.target.id)) {
    if (e.target.id === "fSolCat") $("#fSolSub").value = "";
    renderSol();
  }
});
$("#formSol").addEventListener("submit", async e => {
  e.preventDefault();
  const id = e.target.dataset.id, un = $("#sUn").value.trim(), uid = solUnitMap.get(un);
  const body = { titulo: $("#sTitulo").value, categoria_id: $("#sCat").value, subcategoria_id: $("#sSub").value, unidade_id: uid || "", unidade_txt: uid ? "" : un,
    solicitante: $("#sSol").value, responsavel: $("#sResp").value, prioridade: $("#sPri").value, jira: $("#sJira").value, link: $("#sLink").value, descricao: $("#sDesc").value, etapa_id: $("#sEtapa").value,
    criado_em: $("#sCriado").value, finalizado_em: $("#sFinal").value };
  const encerra = firstEtapa(true), jaFinal = S.sol.etapas.find(e => e.id == body.etapa_id)?.final;
  if (body.finalizado_em && !jaFinal && encerra) body.etapa_id = encerra.id;      // data de finalização preenchida = chamado encerrado
  try {
    if (id) { await api("/sol/" + id, "PUT", body); if (+body.etapa_id !== solOrigEtapa) await api(`/sol/${id}/etapa`, "PUT", { etapa_id: body.etapa_id, finalizado_em: body.finalizado_em }); }
    else await api("/sol", "POST", body);
    $("#dlgSol").close(); await load(true); toast("Solicitação salva.");
  } catch (err) { $("#errSol").textContent = err.message; }
});

/* arrastar e soltar entre as etapas */
document.addEventListener("dragstart", e => {
  const c = e.target.closest && e.target.closest(".sc"); if (!c) return;
  solDrag = true; e.dataTransfer.setData("text/plain", "sol:" + c.dataset.sol); e.dataTransfer.effectAllowed = "move"; c.classList.add("dragging");
});
document.addEventListener("dragend", () => { if (!solDrag) return; solDrag = false; $$(".sc.dragging, .over").forEach(x => x.classList.remove("dragging", "over")); renderSol(); });
document.addEventListener("dragover", e => {
  const z = solDrag && e.target.closest && e.target.closest(".scol, .sfinish"); if (!z) return;
  e.preventDefault(); $$(".over").forEach(x => x.classList.remove("over")); z.classList.add("over");
});
document.addEventListener("drop", e => {
  const z = solDrag && e.target.closest && e.target.closest(".scol, .sfinish"); if (!z) return;
  e.preventDefault();
  const d = e.dataTransfer.getData("text/plain"); if (!d.startsWith("sol:")) return;
  const id = d.slice(4), target = z.dataset.etapa || z.dataset.final;
  moveSol(id, target).then(() => { if (z.dataset.final) toast("Solicitação finalizada."); });
});
