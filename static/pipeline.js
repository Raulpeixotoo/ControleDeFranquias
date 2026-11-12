"use strict";
/* ===== Novas franquias: pipeline de abertura (fase -> tipo -> campo) =====
   Depende de app.js (S, api, esc, norm, $, $$, toast, load, show, ago, fmtDate, UFS em S.ufs). */

const PARADA_DIAS = 30;                       // sem nenhuma alteracao ha tantos dias = "parada"
const PIPE_NA = new Set(["n/a", "na", "n", "nao", "isento"]);
const PIPE_AND = new Set(["andamento", "em andamento", "solicitado", "enviado", "aguardando"]);
const STATUS_OPTS = [["", "— vazio"], ["-", "Pendente"], ["ok", "OK"], ["andamento", "Em andamento"], ["n/a", "Não se aplica"], ["negado", "Bloqueado / negado"]];
let abOpenId = null, abUpPending = null;

/* ---------- interpretacao dos valores ---------- */
function interp(raw) {
  const v = norm(raw);
  if (v === "") return "vazio";
  if (v === "-" || v === "--") return "pend";
  if (PIPE_NA.has(v)) return "na";
  if (v === "negado" || v === "reprovado") return "bloq";
  if (PIPE_AND.has(v) || v.startsWith("solicitado")) return "and";
  return "ok";                                 // ok, same, datas, codigos, e-mails...
}
function parseStart(s) {
  s = String(s || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{2})$/);          // chega como aa.mm.dd (maioria) ou dd.mm.aa
  if (!m) return null;
  const [a, b, c] = [+m[1], +m[2], +m[3]], now = Date.now(), y0 = new Date().getFullYear();
  const cands = [];
  if (b >= 1 && b <= 12 && c >= 1 && c <= 31) cands.push(new Date(2000 + a, b - 1, c));
  if (b >= 1 && b <= 12 && a >= 1 && a <= 31) cands.push(new Date(2000 + c, b - 1, a));
  return cands.find(d => d.getTime() <= now + 7 * 864e5 && d.getFullYear() >= y0 - 8) || null;
}
const daysSince = d => (Date.now() - (d instanceof Date ? d : new Date(d)).getTime()) / 864e5;
function ageText(d) {
  const n = Math.max(0, Math.round(daysSince(d)));
  return n < 30 ? `${n} d` : n < 365 ? `${Math.round(n / 30)} m` : `${(n / 365).toFixed(1).replace(".", ",")} a`;
}
const isoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

/* ---------- modelo ---------- */
function pipeModel() {
  const P = S.pipeline || { fases: [], tipos: [], campos: [], aberturas: [] };
  const byFase = Object.fromEntries(P.fases.map(f => [f.id, []]));
  const ident = [], papel = {};
  for (const c of P.campos) {
    if (c.papel) papel[c.papel] = String(c.id);
    if (c.fase_id && byFase[c.fase_id]) byFase[c.fase_id].push(c); else ident.push(c);
  }
  return { P, fases: P.fases, byFase, ident, papel, tipoName: Object.fromEntries(P.tipos.map(t => [t.id, t.nome])) };
}
function abCalc(ab, M) {
  const ph = M.fases.map(f => {
    let ok = 0, na = 0, bloq = 0, tot = 0; const pend = [], blocked = [];
    for (const c of M.byFase[f.id]) {
      const s = interp(ab.v[c.id]); tot++;
      if (s === "na") na++; else if (s === "ok") ok++; else { pend.push(c); if (s === "bloq") { bloq++; blocked.push(c); } }
    }
    const ap = tot - na;
    return { f, ok, na, bloq, ap, tot, pct: ap ? Math.round(ok / ap * 100) : (tot ? 100 : 0), pend, blocked };
  });
  const apT = ph.reduce((a, p) => a + p.ap, 0), okT = ph.reduce((a, p) => a + p.ok, 0);
  const cur = ph.find(p => p.ap > 0 && p.pct < 100) || null;
  const golive = ab.v[M.papel.golive] || "", standby = /stand/i.test(golive);
  const start = parseStart(ab.v[M.papel.start]);
  const stale = daysSince(ab.last_change_at) >= PARADA_DIAS;
  let status = "andamento";
  if (ab.saiu_em) status = "saiu"; else if (apT === 0) status = "descartada"; else if (standby) status = "standby"; else if (!cur) status = "concluida";
  return { ph, cur, golive, standby, start, stale, status, overall: apT ? Math.round(okT / apT * 100) : 0,
    blocked: ph.flatMap(p => p.blocked), goDate: isoDate(golive) ? new Date(golive + "T00:00:00") : null };
}
function pipeAll() {
  const M = pipeModel();
  return { M, rows: M.P.aberturas.map(ab => ({ ab, c: abCalc(ab, M) })) };
}

/* ---------- widgets do painel ---------- */
function pipeKpi() {
  const { rows } = pipeAll(), act = rows.filter(r => r.c.status === "andamento");
  const sb = rows.filter(r => r.c.status === "standby").length, bl = act.filter(r => r.c.blocked.length).length;
  return kpi(act.length, "novas franquias em andamento", `${sb} em stand-by · ${bl} com bloqueio`, bl ? "warn" : "", "pipeline");
}
function pipeFaseBars() {
  const { M, rows } = pipeAll();
  const data = M.fases.map(f => ({ label: f.nome, n: rows.filter(r => r.c.status === "andamento" && r.c.cur && r.c.cur.f.id === f.id).length, attr: 'data-go="pipeline"' }));
  data.push({ label: "Concluídas", n: rows.filter(r => r.c.status === "concluida").length, color: "var(--ok)", attr: 'data-go="pipeline"' });
  data.push({ label: "Stand-by", n: rows.filter(r => r.c.status === "standby").length, color: "var(--none)", attr: 'data-go="pipeline"' });
  return rows.length ? bars(data) : `<div class="empty">Envie a planilha em Novas franquias</div>`;
}
function pipeGoLive() {
  const { rows } = pipeAll(), today = new Date(new Date().toDateString());
  const list = rows.filter(r => r.c.status === "andamento" && r.c.goDate && r.c.goDate >= today).sort((a, b) => a.c.goDate - b.c.goDate).slice(0, 6);
  return list.length ? `<div class="list">${list.map(r => `<div class="item" data-ab="${r.ab.id}"><span class="badge b-baixa">${fmtDate(r.c.golive)}</span>
    <div class="main"><div class="t">${esc(r.ab.nome)}</div><div class="s">${r.c.cur ? esc(r.c.cur.f.nome) + " · " + r.c.cur.pct + "%" : ""} · previsão (sem prazo fixo)</div></div></div>`).join("")}</div>`
    : `<div class="empty">Nenhuma previsão de Go Live futura</div>`;
}

/* ---------- quadro de candidatos ---------- */
function fillPipeFilters() {
  const { M, rows } = pipeAll();
  fillSelect($("#fPipeUf"), [...new Set(rows.map(r => r.ab.uf))].sort(), { first: "Todas UFs" });
  fillSelect($("#fPipeFase"), M.fases, { first: "Qualquer fase atual", value: f => f.id, label: f => f.nome });
}
const priRank = ab => priRankOf(ab.prioridade);
let pipeMode = localStorage.getItem("cf_pipemode") || "cards";

/* aplica os filtros da barra; usado pelas 3 visoes (cards, planilha, solicitacoes) */
function pipeList() {
  const { M, rows } = pipeAll();
  const q = norm($("#fPipeQ").value), uf = $("#fPipeUf").value, fase = $("#fPipeFase").value, sit = $("#fPipeSit").value,
    sort = $("#fPipeSort").value, pri = $("#fPipePri").value;
  const sitOk = r => ({
    andamento: r.c.status === "andamento", todas: r.c.status !== "saiu", standby: r.c.status === "standby", bloq: r.c.blocked.length > 0 && r.c.status !== "saiu",
    parada: r.c.stale && r.c.status === "andamento", concluida: r.c.status === "concluida", saiu: r.c.status === "saiu", descartada: r.c.status === "descartada",
  }[sit] ?? true);
  const list = rows.filter(r => sitOk(r) && (!uf || r.ab.uf === uf) && (!fase || (r.c.cur && String(r.c.cur.f.id) === fase)) &&
    (!pri || (pri === "none" ? !r.ab.prioridade : r.ab.prioridade === pri)) &&
    (!q || norm([r.ab.nome, r.ab.v[M.papel.candidato]].join(" ")).includes(q)));
  list.sort((a, b) => sort === "nome" ? a.ab.nome.localeCompare(b.ab.nome)
    : sort === "start" ? ((b.c.start || 0) - (a.c.start || 0))
    : sort === "prioridade" ? (priRank(a.ab) - priRank(b.ab)) || (b.c.overall - a.c.overall) || a.ab.nome.localeCompare(b.ab.nome)
    : (b.c.overall - a.c.overall) || a.ab.nome.localeCompare(b.ab.nome));
  return { M, rows, list };
}

function renderPipe() {
  const elC = $("#pipeCards");
  if (!elC) return;
  const { M, rows, list } = pipeList();
  const empty = !M.P.aberturas.length;
  $("#pipeCards").hidden = empty ? false : pipeMode !== "cards";
  $("#pipeGrid").hidden = empty || pipeMode !== "grid";
  $("#pipeReq").hidden = empty || pipeMode !== "req";
  $$("#pipeMode button").forEach(b => b.classList.toggle("active", b.dataset.mode === pipeMode));
  if (empty) {
    $("#pipeSummary").innerHTML = "";
    elC.innerHTML = `<div class="empty">Nenhum candidato ainda.<br>Use “Planilha” para carregar a aba <strong>start_26</strong> ou “Candidato” para cadastrar um.</div>`;
    return;
  }
  const count = k => rows.filter(r => r.c.status === k).length;
  $("#pipeSummary").innerHTML = `<span class="badge b-baixa">${count("andamento")} em andamento</span> <span class="badge b-ok">${count("concluida")} concluídas</span>
    <span class="badge b-none">${count("standby")} stand-by</span> <span class="badge b-alta">${rows.filter(r => r.c.blocked.length && r.c.status !== "saiu").length} com bloqueio</span>
    <span class="badge b-media">${rows.filter(r => r.c.stale && r.c.status === "andamento").length} paradas há ${PARADA_DIAS}+ dias</span>
    <span class="pri pri-urgente">${rows.filter(r => r.ab.prioridade === "urgente" && r.c.status === "andamento").length} urgentes</span>
    <span class="pri pri-alta">${rows.filter(r => r.ab.prioridade === "alta" && r.c.status === "andamento").length} alta</span>
    <span class="muted"> · mostrando ${list.length}</span>`;
  if (pipeMode === "grid") return renderGrid(M, list);
  if (pipeMode === "req") return renderReq(M, list);
  elC.innerHTML = list.length ? list.map(({ ab, c }) => {
    const falta = c.cur ? c.cur.pend.filter(x => interp(ab.v[x.id]) !== "bloq").slice(0, 3).map(x => esc(x.label)).join(", ") : "";
    const maisN = c.cur ? Math.max(0, c.cur.pend.length - 3) : 0;
    const flags = [
      c.status === "concluida" ? `<span class="badge b-ok">Concluída</span>` : "", ab.unidade_id && S.units.some(u => u.id == ab.unidade_id) ? `<span class="badge b-ok">Nas unidades ativas</span>` : "", c.status === "standby" ? `<span class="badge b-none">Stand-by</span>` : "",
      c.status === "saiu" ? `<span class="badge b-none">Saiu da planilha</span>` : "", c.status === "descartada" ? `<span class="badge b-none">Tudo “n/a”</span>` : "",
      ...c.blocked.slice(0, 2).map(x => `<span class="badge b-critica" title="Campo com valor negado">Bloqueado: ${esc(x.label)}</span>`),
      c.stale && c.status === "andamento" ? `<span class="badge b-media">Parada há ${Math.round(daysSince(ab.last_change_at))} d</span>` : "",
    ].join(" ");
    return `<article class="fc st-${c.status}" data-ab="${ab.id}" tabindex="0">
      <div style="display:flex;gap:8px;justify-content:space-between;align-items:center"><span class="name">${esc(ab.nome)}</span><span>${priBadge(ab.prioridade)} <span class="badge b-none">${esc(ab.uf)}</span></span></div>
      <div class="meta">${ic("user")} ${esc(ab.v[M.papel.candidato] || "sem candidato")}${ab.v[M.papel.celular] ? " · " + esc(ab.v[M.papel.celular]) : ""}</div>
      <div class="meta">conversa iniciada ${c.start ? `há ${ageText(c.start)}` : "—"} · Go Live: ${c.standby ? "stand-by" : isoDate(c.golive) ? fmtDate(c.golive) + " (previsão)" : "sem previsão"}</div>
      <div class="phases">${c.ph.map(p => `<div class="ph" title="${esc(p.f.nome)}: ${p.ok}/${p.ap} (${p.pct}%)"><div class="lbl">${esc(p.f.nome.replace(/^fase\s*/i, "").slice(0, 14))}</div>
        <div class="track"><div class="fill ${p.bloq ? "bad" : ""}" style="width:${p.pct}%"></div></div><div class="pct">${p.pct}%</div></div>`).join("")}</div>
      ${c.cur ? `<div class="meta"><strong>${esc(c.cur.f.nome)}</strong> — falta: ${falta || "—"}${maisN ? ` (+${maisN})` : ""}</div>` : ""}
      <div class="flags">${flags}</div></article>`;
  }).join("") : `<div class="empty">Nenhum candidato com esses filtros.</div>`;
}

/* ---------- detalhe do candidato ---------- */
function ctlHtml(c, raw) {
  const id = c.id;
  if (c.kind === "status") {
    const known = STATUS_OPTS.some(([v]) => v.toLowerCase() === String(raw).toLowerCase());
    const opts = STATUS_OPTS.map(([v, l]) => `<option value="${esc(v)}" ${String(raw).toLowerCase() === v.toLowerCase() ? "selected" : ""}>${l}</option>`).join("")
      + (!known ? `<option value="${esc(raw)}" selected>${esc(raw)}</option>` : "");
    return `<select data-campo="${id}">${opts}</select>`;
  }
  if (c.kind === "data") {
    return `<input type="date" data-campo="${id}" value="${isoDate(raw) ? raw : ""}">
      ${raw && !isoDate(raw) ? `<span class="muted rawv" title="valor original">${esc(raw)}</span>` : ""}
      <button type="button" class="btn sm ghost" data-setv="n/a" data-campo-id="${id}">n/a</button><button type="button" class="btn sm ghost" data-setv="" data-campo-id="${id}">limpar</button>`;
  }
  return `<input type="text" data-campo="${id}" value="${esc(raw)}" maxlength="500">`;
}
function phaseSummary(p) { return `${esc(p.f.nome)} · ${p.pct}%${p.bloq ? " · bloqueio" : ""} <span class="muted">(${p.ok}/${p.ap})</span>`; }

function openAb(id) {
  const { M, rows } = pipeAll(), r = rows.find(x => x.ab.id == id);
  if (!r) return;
  abOpenId = r.ab.id;
  const { ab, c } = r;
  $("#abTitle").textContent = ab.nome;
  $("#abNome").value = ab.nome;
  $("#abPri").innerHTML = priOptions(ab.prioridade);
  fillSelect($("#abUf"), S.ufs, { selected: ab.uf });
  const row = cp => `<div class="frow"><label>${esc(cp.label)}</label><div>${ctlHtml(cp, ab.v[cp.id] || "")}</div></div>`;
  let html = M.ident.length ? `<section class="fsec"><h4>Identificação</h4>${M.ident.map(row).join("")}</section>` : "";
  html += c.ph.map(p => {
    const groups = new Map();
    for (const cp of M.byFase[p.f.id]) { const k = M.tipoName[cp.tipo_id] || "Geral"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(cp); }
    return `<details class="fsec" ${c.cur && c.cur.f.id === p.f.id ? "open" : ""}><summary id="phs-${p.f.id}">${phaseSummary(p)}</summary>
      ${[...groups].map(([t, cps]) => `<h5>${esc(t)}</h5>${cps.map(row).join("")}`).join("") || `<div class="muted">Sem campos nesta fase.</div>`}</details>`;
  }).join("");
  $("#abBody").innerHTML = html;
  $("#abSaved").textContent = "";
  const sent = ab.unidade_id && S.units.some(u => u.id == ab.unidade_id);
  $("#btnAbToUnit").lastElementChild.textContent = sent ? "Já nas unidades ativas — abrir unidade" : "Enviar para unidades ativas";
  $("#btnAbToUnit").classList.toggle("primary", !sent);
  $("#abMeta").innerHTML = `<span class="muted">última alteração ${ago(ab.last_change_at)}${c.start ? ` · conversa iniciada há ${ageText(c.start)}` : ""}</span>`;
  $("#dlgAb").showModal();
}
async function saveValor(campoId, valor, abId = abOpenId) {
  const ab = S.pipeline.aberturas.find(a => a.id == abId); if (!ab) return;
  try {
    const r = await api(`/aberturas/${ab.id}/valor`, "PUT", { campo_id: campoId, valor });
    if (valor === "") delete ab.v[campoId]; else ab.v[campoId] = valor;
    if (r.changed) ab.last_change_at = new Date().toISOString();
    if (abOpenId == ab.id && $("#dlgAb").open) {
      const M = pipeModel(), c = abCalc(ab, M);
      c.ph.forEach(p => { const el = $("#phs-" + p.f.id); if (el) el.innerHTML = phaseSummary(p); });
      $("#abSaved").textContent = "Salvo";
    }
    renderPipe();
  } catch (e) { toast("Não salvou: " + esc(e.message)); if ($("#abSaved")) $("#abSaved").textContent = "Erro: " + e.message; }
}

/* ---------- configuracao do pipeline ---------- */
function renderCfg() {
  const P = S.pipeline, scrollPos = $("#cfgBody").scrollTop;
  const opt = (arr, sel, none) => (none ? `<option value="">${none}</option>` : "") + arr.map(x => `<option value="${x.id}" ${x.id == sel ? "selected" : ""}>${esc(x.nome)}</option>`).join("");
  const list = (kind, arr) => `<div>${arr.map((x, i) => `<div class="cfgrow"><input data-cfg="${kind}" data-id="${x.id}" data-f="nome" value="${esc(x.nome)}">
    <button class="btn sm ghost" data-cfgmv="${kind}" data-id="${x.id}" data-d="-1" ${i === 0 ? "disabled" : ""}>↑</button><button class="btn sm ghost" data-cfgmv="${kind}" data-id="${x.id}" data-d="1" ${i === arr.length - 1 ? "disabled" : ""}>↓</button>
    <button class="btn sm danger ghost" data-cfgdel="${kind}" data-id="${x.id}">✕</button></div>`).join("")}
    <div class="cfgrow"><input id="new-${kind}" placeholder="novo(a) ${kind === "fases" ? "fase" : "tipo"}…"><button class="btn sm" data-cfgadd="${kind}">${ic("plus")} Adicionar</button></div></div>`;
  const campoRow = (c, grp, i) => `<div class="cfgrow"><input data-cfg="campos" data-id="${c.id}" data-f="label" value="${esc(c.label)}">
    <select data-cfg="campos" data-id="${c.id}" data-f="tipo_id">${opt(P.tipos, c.tipo_id, "Geral (sem tipo)")}</select>
    <select data-cfg="campos" data-id="${c.id}" data-f="fase_id">${opt(P.fases, c.fase_id, "Identificação (sem fase)")}</select>
    <select data-cfg="campos" data-id="${c.id}" data-f="kind"><option value="status" ${c.kind === "status" ? "selected" : ""}>status (ok/pendente…)</option><option value="data" ${c.kind === "data" ? "selected" : ""}>data</option><option value="texto" ${c.kind === "texto" ? "selected" : ""}>texto</option></select>
    <label class="chk" title="Entra na lista de Solicitações (dado que pedimos ao franqueado)"><input type="checkbox" data-cfg="campos" data-id="${c.id}" data-f="pedir" ${c.pedir ? "checked" : ""}> pedir</label><select data-cfg="campos" data-id="${c.id}" data-f="nivel" title="Prioridade do pedido ao franqueado"><option value="alta" ${c.nivel === "alta" ? "selected" : ""}>pedido: alta</option><option value="media" ${c.nivel === "media" ? "selected" : ""}>pedido: média</option><option value="baixa" ${c.nivel === "baixa" ? "selected" : ""}>pedido: baixa</option></select><button class="btn sm ghost" data-cfgmv="campos" data-id="${c.id}" data-d="-1" ${i === 0 ? "disabled" : ""}>↑</button><button class="btn sm ghost" data-cfgmv="campos" data-id="${c.id}" data-d="1" ${i === grp.length - 1 ? "disabled" : ""}>↓</button>
    <button class="btn sm danger ghost" data-cfgdel="campos" data-id="${c.id}">✕</button></div>`;
  const groups = [{ nome: "Identificação (sem fase)", id: null }, ...P.fases];
  $("#cfgBody").innerHTML = `<h4>Fases</h4>${list("fases", P.fases)}<h4>Tipos (grupos de informação)</h4>${list("tipos", P.tipos)}
    <h4>Campos por fase</h4>${groups.map(g => { const grp = P.campos.filter(c => (c.fase_id || null) === g.id);
      return `<div class="cfgfase"><strong>${esc(g.nome)}</strong> <span class="muted">(${grp.length})</span>${grp.map((c, i) => campoRow(c, grp, i)).join("")}</div>`; }).join("")}
    <div class="cfgrow"><input id="newCampoLabel" placeholder="Novo campo…"><select id="newCampoFase">${opt(P.fases, null, "Identificação")}</select>
      <select id="newCampoTipo">${opt(P.tipos, null, "Geral")}</select><select id="newCampoKind"><option value="status">status</option><option value="data">data</option><option value="texto">texto</option></select>
      <button class="btn sm" data-cfgadd="campos">${ic("plus")} Campo</button></div>`;
  $("#cfgBody").scrollTop = scrollPos;
}
async function cfgDo(fn) {
  try { await fn(); await load(true); renderCfg(); } catch (e) { toast(esc(e.message)); renderCfg(); }
}

/* ---------- upload da planilha start_NN ---------- */
function openAbUp() {
  abUpPending = null;
  $("#abUpFile").value = ""; $("#abUpResult").innerHTML = ""; $("#errAbUp").textContent = ""; $("#btnAbCommit").hidden = true; $("#btnAbAnalyze").textContent = "Analisar";
  $("#dlgAbUp").showModal();
}
async function analyzeAbUp(e) {
  e.preventDefault();
  const file = $("#abUpFile").files[0]; if (!file) return;
  const fd = new FormData(); fd.append("file", file); fd.append("sheet", $("#abUpSheet").value || "start_26");
  $("#errAbUp").textContent = ""; $("#btnAbAnalyze").disabled = true; $("#btnAbAnalyze").textContent = "Analisando…";
  try {
    const r = await api("/pipeline/preview", "POST", fd); abUpPending = r;
    $("#abUpResult").innerHTML = statGrid([[r.total, "candidatos lidos"], ...(r.primeira ? [[r.novas, "serão cadastrados", "g"]]
        : [[`+${r.novas}`, "novos", "g"], [`−${r.saiu}`, "saíram", "r"], [r.com_mudanca, "com mudanças", "y"], [r.valores_mudados, "campos alterados"]]), [r.n_campos, "colunas"]])
      + `<div class="muted">Aba “${esc(r.sheet)}” · ${r.fases.map(esc).join(" → ")}</div>` + noticeHtml(r.warnings, { total: r.errors.length, lines: r.errors })
      + (r.alerta_queda ? forceHtml("chkAbForce") : "")
      + (r.primeira ? "" : `<div class="chglist">${r.changes.map(x => changeRow({ ...x, meta: x.uf })).join("") || `<div class="empty">Nenhuma diferença.</div>`}</div>`);
    $("#btnAbCommit").hidden = false; $("#btnAbAnalyze").textContent = "Analisar de novo";
  } catch (err) { abUpPending = null; $("#errAbUp").textContent = err.message; $("#btnAbCommit").hidden = true; $("#btnAbAnalyze").textContent = "Analisar"; }
  $("#btnAbAnalyze").disabled = false;
}
async function commitAbUp() {
  const r = abUpPending; if (!r) return;
  if (r.alerta_queda && !$("#chkAbForce")?.checked) { $("#errAbUp").textContent = "Marque a confirmação do alerta de queda."; return; }
  $("#btnAbCommit").disabled = true;
  try {
    await api("/pipeline/commit", "POST", { token: r.token, sheet: r.sheet, force: !!$("#chkAbForce")?.checked });
    $("#dlgAbUp").close(); await load(true); show("pipeline"); toast("Planilha de novas franquias aplicada.");
  } catch (err) { $("#errAbUp").textContent = err.message; }
  $("#btnAbCommit").disabled = false;
}

/* ---------- eventos ---------- */
document.addEventListener("click", async e => {
  const b = e.target.closest("button, [data-ab]");
  if (!b) return;
  if (b.dataset.ab && !b.closest("#dlgAb")) { if (!(editing && b.closest(".w"))) openAb(b.dataset.ab); return; }
  switch (b.id) {
    case "btnAbToUnit": {
      const { M, rows } = pipeAll(), ab = rows.find(x => x.ab.id == abOpenId)?.ab; if (!ab) return;
      $("#dlgAb").close();
      if (ab.unidade_id && S.units.some(u => u.id == ab.unidade_id)) return openUnit(ab.unidade_id);
      const first = (ab.nome.split(/\s+/)[0] || "").toUpperCase(), cand = ab.v[M.papel.candidato] || "";
      return openUnit(null, { nome: ab.nome, uf: ab.uf, tipo: TIPO_LABEL[first] ? first : "", situacao: "ativa", responsavel: cand, franqueado: cand,
        celular: ab.v[M.papel.celular] || "", desde: new Date().toISOString().slice(0, 10) }, ab.id);
    }
    case "btnAbUpload": return openAbUp();
    case "btnAbCommit": return commitAbUp();
    case "btnAbNew": $("#formAbNew").reset(); fillSelect($("#abNewUf"), S.ufs); $("#errAbNew").textContent = ""; return $("#dlgAbNew").showModal();
    case "btnPipeCfg": renderCfg(); return $("#dlgPipeCfg").showModal();
    case "btnDelAb":
      if (!confirm("Excluir este candidato e todos os dados dele?")) return;
      try { await api(`/aberturas/${abOpenId}`, "DELETE"); $("#dlgAb").close(); await load(true); } catch (err) { toast(esc(err.message)); }
      return;
  }
  if (b.dataset.setv !== undefined && b.dataset.campoId) { // n/a / limpar
    await saveValor(b.dataset.campoId, b.dataset.setv);
    const inp = $(`#abBody [data-campo="${b.dataset.campoId}"]`); if (inp) inp.value = "";
    const sib = b.parentElement.querySelector(".rawv"); if (sib) sib.textContent = b.dataset.setv;
    return;
  }
  if (!$("#dlgPipeCfg").contains(b)) return;
  const id = b.dataset.id, kind = b.dataset.cfgmv || b.dataset.cfgdel || b.dataset.cfgadd;
  if (b.dataset.cfgadd) {
    return cfgDo(async () => {
      if (kind === "campos") {
        await api("/pipe/campos", "POST", { label: $("#newCampoLabel").value, fase_id: $("#newCampoFase").value, tipo_id: $("#newCampoTipo").value, kind: $("#newCampoKind").value });
      } else await api("/pipe/" + kind, "POST", { nome: $("#new-" + kind).value });
    });
  }
  if (b.dataset.cfgdel) {
    if (!confirm(kind === "campos" ? "Excluir este campo e os valores dele em todos os candidatos?" : "Excluir?")) return;
    return cfgDo(() => api(`/pipe/${kind}/${id}`, "DELETE"));
  }
  if (b.dataset.cfgmv) {
    const arr = [...S.pipeline[kind]], i = arr.findIndex(x => x.id == id), d = +b.dataset.d;
    const same = x => kind !== "campos" || (x.fase_id || null) === (arr[i].fase_id || null);
    let j = i + d; while (j >= 0 && j < arr.length && !same(arr[j])) j += d;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    return cfgDo(() => api(`/pipe/${kind}/reorder`, "POST", { ids: arr.map(x => x.id) }));
  }
});

document.addEventListener("change", e => {
  const t = e.target;
  if (t.matches("#abBody [data-campo]")) return saveValor(t.dataset.campo, t.value.trim());
  if (t.id === "abPri") return setPrioridade(abOpenId, t.value);
  if (t.id === "abNome" || t.id === "abUf") {
    api(`/aberturas/${abOpenId}`, "PUT", { nome: $("#abNome").value, uf: $("#abUf").value }).then(() => { $("#abTitle").textContent = $("#abNome").value; return load(true); })
      .catch(err => toast(esc(err.message)));
    return;
  }
  if (t.matches("#cfgBody [data-cfg]")) {
    const body = { [t.dataset.f]: t.type === "checkbox" ? (t.checked ? 1 : 0) : t.value };
    cfgDo(() => api(`/pipe/${t.dataset.cfg}/${t.dataset.id}`, "PUT", body));
  }
});
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches(".fc")) openAb(e.target.dataset.ab); });
document.addEventListener("input", e => { if (["fPipeQ", "fPipeUf", "fPipeFase", "fPipeSit", "fPipeSort", "fPipePri"].includes(e.target.id)) renderPipe(); });
$("#formAbUp").addEventListener("submit", analyzeAbUp);
["abUpFile", "abUpSheet"].forEach(id => $("#" + id).addEventListener("input", () => { abUpPending = null; $("#btnAbCommit").hidden = true; $("#btnAbAnalyze").textContent = "Analisar"; }));
$("#formAbNew").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const r = await api("/aberturas", "POST", { nome: $("#abNewNome").value, uf: $("#abNewUf").value });
    $("#dlgAbNew").close(); await load(true); openAb(r.id);
  } catch (err) { $("#errAbNew").textContent = err.message; }
});
