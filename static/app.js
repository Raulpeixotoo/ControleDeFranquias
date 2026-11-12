"use strict";
/* ============ utilidades ============ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

const SEV = { baixa: 1, media: 2, alta: 3, critica: 4 };
const SEV_LABEL = { baixa: "Baixa", media: "Média", alta: "Alta", critica: "Crítica" };
const STATUS_LABEL = { aberta: "Aberta", andamento: "Em andamento", resolvida: "Resolvida" };
const DEFAULT_CATS = ["Sinistro", "Operacional", "Fiscal / Jurídico", "Frota", "Pessoas", "Financeiro", "TI / Sistemas", "Outros"];

const TIPO_LABEL = { CO: "Centro Operacional", LJ: "Loja", PA: "Posto Avançado", FL: "Filial", HB: "Hub", JE: "Franquia Light" };
const tipoLabel = t => (TIPO_LABEL[t] ? `${t} · ${TIPO_LABEL[t]}` : t || "(sem tipo)");
const isLive = u => !u.saiu_em && u.situacao !== "fechada" && u.situacao !== "inativa";
const MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const fmtMonth = ym => { const [y, m] = String(ym).split("-"); return `${MESES[+m - 1] || m}/${y}`; };
const fmtDate = iso => /^\d{4}-\d{2}-\d{2}/.test(iso || "") ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : (iso || "");
const FIELD_LABEL = { sigla: "Sigla", tipo: "Tipo", nome: "Nome", uf: "UF", cidade: "Cidade", ponto: "Ponto", aeroporto: "Aeroporto",
  desde: "Abertura (desde)", cnpj: "CNPJ", razao_social: "Razão social", endereco: "Endereço", bairro: "Bairro", cep: "CEP",
  telefone: "Telefone", celular: "Celulares gestores", email: "E-mail oficial", email_gestor: "E-mail gestor", franqueado: "Responsável (franqueado / gerente / parceiro operacional)", unidade_master: "Unidade responsável (master)",
  equipe: "Equipe", consultor: "Consultor de campo", funcionamento: "Funcionamento", visitada: "Visitada", triagem: "Triagem", situacao: "Situação" };
const fieldLabel = k => k.startsWith("extra:") ? k.slice(6) : (FIELD_LABEL[k] || k);

/* ============ componentes de interface compartilhados ============ */
const PRIORIDADES = [["urgente", "Urgente"], ["alta", "Alta"], ["media", "Média"], ["baixa", "Baixa"]];   // da mais para a menos prioritária
const PRI_LABEL = Object.fromEntries(PRIORIDADES);
const priRankOf = p => { const i = PRIORIDADES.findIndex(([k]) => k === p); return i < 0 ? PRIORIDADES.length : i; };
const priBadge = p => p ? `<span class="pri pri-${p}">${PRI_LABEL[p]}</span>` : "";
const priOptions = selected => `<option value="">— sem prioridade</option>` + PRIORIDADES.map(([v, l]) => `<option value="${v}" ${v === (selected || "") ? "selected" : ""}>${l}</option>`).join("");

const ic = name => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const showUser = () => { $("#btnUser").innerHTML = `${ic("user")} ${esc(user)}`; };
const optionTag = (value, label) => `<option value="${esc(value)}">${esc(label)}</option>`;
/* Reabastece um <select> (opção fixa + extras + itens) mantendo a seleção atual enquanto ela ainda existir. */
function fillSelect(sel, items, { first, extra = [], value = x => x, label = value, selected } = {}) {
  const cur = String(selected ?? sel.value);
  sel.innerHTML = (first === undefined ? "" : optionTag("", first)) + extra.map(([v, l]) => optionTag(v, l)).join("") + items.map(x => optionTag(value(x), label(x))).join("");
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : (sel.options[0] ? sel.options[0].value : "");
}

const statGrid = items => `<div class="sumgrid">${items.map(([n, label, tone = ""]) => `<div class="sum ${tone}"><b>${n}</b>${label}</div>`).join("")}</div>`;
const forceHtml = id => `<label class="force"><input type="checkbox" id="${id}"> Sei que o total caiu muito e quero atualizar mesmo assim</label>`;
function noticeHtml(warnings, ignored) {
  const w = warnings.map(t => `<div class="warnbox ${t.startsWith("ATENÇÃO") ? "bad" : ""}">${esc(t)}</div>`).join("");
  return w + (ignored.total ? `<div class="warnbox"><strong>${ignored.total} linha(s) ignorada(s):</strong><br>${ignored.lines.slice(0, 8).map(esc).join("<br>")}${ignored.total > 8 ? "<br>…" : ""}</div>` : "");
}
const CHG_KIND = { nova: ["b-ok", "Nova"], saiu: ["b-critica", "Saiu"], reativada: ["b-baixa", "Voltou"], alterada: ["b-media", "Alterada"] };
function diffHtml(diff, label = k => k, mais = 0) {
  const keys = Object.keys(diff || {});
  if (!keys.length) return "";
  const hidden = Math.max(0, keys.length - 12) + mais;
  return `<div class="diff">${keys.slice(0, 12).map(k => `${esc(label(k))}: ${diff[k][0] ? `<s>${esc(diff[k][0])}</s>` : "<i>vazio</i>"} → ${diff[k][1] ? `<b>${esc(diff[k][1])}</b>` : "<i>vazio</i>"}`).join("<br>")}${hidden ? `<br>… e mais ${hidden}` : ""}</div>`;
}
function changeRow({ kind, nome, meta, diff, label, mais }) {
  const [cls, txt] = CHG_KIND[kind];
  return `<div class="chg"><span class="badge ${cls}">${txt}</span> <strong>${esc(nome)}</strong> <span class="muted">${esc(meta)}</span>${diffHtml(diff, label, mais)}</div>`;
}

function ago(iso) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return "agora";
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return `há ${d} d`;
}

/* ============ estado ============ */
let S = { units: [], incidents: [], log: [], snapshots: [], latest_changes: [], pipeline: { fases: [], tipos: [], campos: [], aberturas: [] },
  sol: { categorias: [], subcategorias: [], etapas: [], abertas: [], jira_base: "" }, sol_units: {}, ufs: [] };
let unitLimit = 120, pendingUpload = null, lastRev = null;
const EXPECTED_VERSION = 10;
let lastJson = "";
let seenCrit = null;           // ids de criticas ja vistas (null = primeira carga)
let user = localStorage.getItem("cf_user") || "";
let code = localStorage.getItem("cf_code") || "";
let editing = false, dragging = false;
let currentView = "painel";

/* ============ API ============ */
async function api(path, method = "GET", body) {
  for (let tries = 0; tries < 3; tries++) {
    const isForm = body instanceof FormData;
    let res;
    try { res = await fetch("/api" + path, {
      method,
      headers: { ...(isForm ? {} : { "Content-Type": "application/json" }), "X-User": encodeURIComponent(user), "X-Access-Code": code },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(method === "GET" ? 30000 : 120000),
    }); } catch (err) {
      if (err.name === "TimeoutError" || err.name === "AbortError") throw new Error("O servidor demorou a responder. Tente novamente; consulte os tempos da requisição se o problema continuar.");
      throw err;
    }
    if (res.status === 401) { await askCode(tries > 0); continue; }
    const data = await res.json().catch(() => ({}));
    if (res.status === 503 && method === "GET" && data.retryable && tries === 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }
    if (!res.ok) throw new Error(data.error || (res.status === 404 ? "Recurso não encontrado: o servidor está desatualizado. Feche a janela do iniciar.bat e abra de novo." : `Erro ${res.status}`));
    return data;
  }
  throw new Error("acesso negado");
}

function askCode(wrong) {
  return new Promise(resolve => {
    const dlg = $("#dlgCode");
    $("#errCode").textContent = wrong ? "Código incorreto." : "";
    $("#formCode").onsubmit = e => {
      e.preventDefault();
      code = new FormData(e.target).get("codigo");
      localStorage.setItem("cf_code", code);
      dlg.close(); resolve();
    };
    if (!dlg.open) dlg.showModal();
  });
}

function askName() {
  return new Promise(resolve => {
    const dlg = $("#dlgName");
    $("#formName").onsubmit = e => {
      e.preventDefault();
      user = String(new FormData(e.target).get("nome")).trim();
      localStorage.setItem("cf_user", user);
      dlg.close(); resolve();
    };
    dlg.addEventListener("cancel", ev => ev.preventDefault());
    dlg.showModal();
  });
}

/* ============ derivados ============ */
function derive() {
  const open = S.incidents.filter(i => i.status !== "resolvida");
  const health = {};                 // unit_id -> {worst, open: []}
  for (const u of S.units) health[u.id] = { worst: 0, open: [] };
  for (const i of open) {
    const h = health[i.unit_id]; if (!h) continue;
    h.open.push(i); h.worst = Math.max(h.worst, SEV[i.severidade] || 0);
  }
  const unitById = Object.fromEntries(S.units.map(u => [u.id, u]));
  return { open, incidents: S.incidents, health, unitById };
}
const sevName = n => ["", "baixa", "media", "alta", "critica"][n] || "";
const sevBadge = s => `<span class="badge b-${s}">${SEV_LABEL[s]}</span>`;
const healthBadge = w => w ? sevBadge(sevName(w)) : `<span class="badge b-ok">OK</span>`;

/* ============ widgets do painel ============ */
function kpi(num, label, sub, cls = "", go = "") {
  return `<div class="kpi ${cls}" data-go="${go}"><div class="num">${num}</div><div>${label}</div><div class="sub">${sub}</div></div>`;
}
function bars(rows, color) {
  if (!rows.length) return `<div class="empty">Sem dados</div>`;
  const max = Math.max(...rows.map(r => r.n), 1);
  return `<div class="bars">${rows.map(r => `<div class="bar" ${r.attr || ""}><span class="lbl" title="${esc(r.label)}">${esc(r.label)}</span>
    <span class="track"><span class="fill" style="width:${r.n / max * 100}%;background:${r.color || color || ""}"></span></span><span class="n">${r.n}</span></div>`).join("")}</div>`;
}
function countBy(arr, fn) {
  const m = new Map();
  for (const x of arr) { const k = fn(x) || "(sem informação)"; m.set(k, (m.get(k) || 0) + 1); }
  return [...m].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
}
const sum = arr => (arr || []).reduce((a, b) => a + b, 0);
function colChart(items) {
  const max = Math.max(...items.map(i => i.v), 1);
  return `<div class="cols">${items.map(i => `<div class="col ${i.cur ? "cur" : ""}" title="${esc(i.label)}: ${i.v}"><span class="v">${i.v}</span>
    <i style="height:${i.v / max * 78}%"></i><span class="m">${esc(i.label)}</span></div>`).join("")}</div>`;
}
/* aberturas: ano -> [12 meses], a partir da data "desde" (inclui unidades hoje fechadas: e historico de aberturas) */
function openings(tipo, uf, pred) {
  const m = {}, maxY = new Date().getFullYear() + 1;
  for (const u of S.units) {
    if (tipo && u.tipo !== tipo) continue;
    if (uf && u.uf !== uf) continue;
    if (pred && !pred(u)) continue;
    if (!/^\d{4}-\d{2}/.test(u.desde || "")) continue;
    const y = +u.desde.slice(0, 4), mo = +u.desde.slice(5, 7) - 1;
    if (y < 1980 || y > maxY) continue;
    (m[y] ||= Array(12).fill(0))[mo]++;
  }
  return m;
}
function abYears(m, n) {
  const ys = Object.keys(m).map(Number); if (!ys.length) return [];
  const cy = new Date().getFullYear(), start = n ? Math.max(cy - n + 1, Math.min(...ys)) : Math.min(...ys), out = [];
  for (let y = start; y <= cy; y++) out.push(y);
  return out;
}
function delta(cur, prev) {
  const d = cur - prev;
  if (!d) return `<span class="muted">= igual</span>`;
  const pct = prev ? ` (${d > 0 ? "+" : ""}${Math.round(d / prev * 100)}%)` : "";
  return `<span class="${d > 0 ? "up" : "down"}">${d > 0 ? "▲ +" : "▼ "}${d}${pct}</span>`;
}

let abTipos = (() => { try { const value = JSON.parse(localStorage.getItem("cf_ab_tipos")); return value === "all" || Array.isArray(value) ? value : null; } catch { return null; } })();
const abSel = u => abTipos === "all" || (Array.isArray(abTipos) ? abTipos : MAIN_TIPOS).includes(u.tipo);
function renderAbFilter() {
  const tipos = [...new Set([...MAIN_TIPOS, ...S.units.map(u => u.tipo).filter(Boolean)])];
  const selected = abTipos === "all" ? tipos : Array.isArray(abTipos) ? abTipos : MAIN_TIPOS;
  $("#abTypeFilter").innerHTML = '<span class="muted">Tipos de unidade:</span>' + tipos.map(t =>
    `<button class="fchip ${selected.includes(t) ? "on" : ""}" aria-pressed="${selected.includes(t)}" data-abtipo="${esc(t)}" title="${esc(tipoLabel(t))}">${esc(t)} <small>${S.units.filter(u => u.tipo === t).length}</small></button>`).join("") +
    '<span class="spacer"></span><button class="btn sm ghost" data-abpreset="main">Só CO · LJ · PA · FL</button><button class="btn sm ghost" data-abpreset="all">Todos</button>';
}
$("#abTypeFilter").addEventListener("click", e => {
  const type = e.target.closest('[data-abtipo]')?.dataset.abtipo, preset = e.target.closest('[data-abpreset]')?.dataset.abpreset;
  if (preset) abTipos = preset === "all" ? "all" : null;
  else if (type) {
    const all = [...new Set([...MAIN_TIPOS, ...S.units.map(u => u.tipo).filter(Boolean)])];
    const current = abTipos === "all" ? all : Array.isArray(abTipos) ? abTipos : MAIN_TIPOS;
    abTipos = current.includes(type) ? current.filter(t => t !== type) : [...current, type];
  } else return;
  localStorage.setItem("cf_ab_tipos", JSON.stringify(abTipos)); renderAb();
});
function renderAb() {
  renderAbFilter();
  const uf = $("#fAbUf").value, n = +$("#fAbAnos").value;
  const m = openings("", uf, abSel), years = abYears(m, n), el = $("#abContent");
  if (!years.length) { el.innerHTML = '<div class="empty">Nenhuma abertura encontrada para os tipos e a UF selecionados.</div>'; return; }
  const now = new Date(), cy = now.getFullYear(), cm = now.getMonth(), py = cy - 1;
  const ytd = y => sum((m[y] || []).slice(0, cm + 1)), cell = (y,i) => (m[y] || [])[i] || 0;
  const old = S.units.filter(u => isLive(u) && abSel(u) && (!uf || u.uf === uf) && /^\d{4}/.test(u.desde || "") && +u.desde.slice(0,4) <= cy - 10).length;
  const card = (t,big,sub) => `<div class="w"><h4>${t}</h4><div class="kpi"><div class="num">${big}</div><div class="sub">${sub}</div></div></div>`;
  const ordered = [...years].reverse(), max = Math.max(...years.map(y => sum(m[y])),1);
  const chart = ordered.map(y => `<div class="annual-bar ${y === cy ? "current" : ""}"><strong>${y}</strong><div class="annual-track"><span style="width:${sum(m[y]) / max * 100}%"></span></div><b>${sum(m[y])}</b></div>`).join("");
  const head = `<tr><th scope="col">Ano</th>${MESES.map(m => `<th scope="col">${m}</th>`).join("")}<th scope="col">Total</th><th scope="col">Até ${MESES[cm]}</th><th scope="col">Variação*</th></tr>`;
  const body = ordered.map(y => `<tr class="${y === cy ? "current" : ""}"><th scope="row">${y}</th>${MESES.map((_,i) => `<td>${y === cy && i > cm ? "—" : cell(y,i) || '<span class="muted">·</span>'}</td>`).join("")}<td><strong>${sum(m[y])}</strong></td><td>${ytd(y)}</td><td>${delta(ytd(y),ytd(y-1))}</td></tr>`).join("");
  const missing = S.units.filter(u => abSel(u) && (!uf || u.uf === uf) && !/^\d{4}-\d{2}/.test(u.desde || "")).length;
  el.innerHTML = `<div class="ab-grid">
    ${card(`${cy} até ${MESES[cm]}`,ytd(cy),`${ytd(py)} no mesmo período de ${py} · ${delta(ytd(cy),ytd(py))}`)}
    ${card(`${MESES[cm]}/${cy}`,cell(cy,cm),`${cell(py,cm)} no mesmo mês de ${py}`)}
    ${card(`Total de ${py}`,sum(m[py]),`${sum(m[py-1])} em ${py-1}`)}
    ${card("Ativas com 10+ anos",old,"unidades com uma década de operação")}
    </div><div class="annual-layout"><div class="w annual-chart"><h4>Aberturas por ano</h4><p class="muted">Quantidade de unidades inauguradas</p><div class="annual-bars">${chart}</div></div>
    <div class="w annual-context"><h4>Como ler esta visão</h4><p>Os botões de tipo e o filtro de UF atualizam os indicadores, o gráfico e a tabela.</p><p>O histórico inclui unidades que hoje estão fechadas. As datas vêm da coluna DESDE.</p><p class="muted">${missing} unidade(s) nos filtros sem data de abertura informada.</p></div></div>
    <div class="w annual-comparison"><h4>Comparativo mensal</h4><p class="muted">Um ano por linha. * Variação até ${MESES[cm]} em relação ao mesmo período do ano anterior.</p><div class="tablewrap" tabindex="0" role="region" aria-label="Comparativo mensal de aberturas"><table class="cmp annual-table"><thead>${head}</thead><tbody>${body}</tbody></table></div></div>`;
}

/* ============ atualizacoes (planilha mensal) ============ */
const chgHtml = c => changeRow({ kind: c.kind, nome: c.nome, meta: `${(c.chave || "").split("|")[0]} · ${tipoLabel(c.tipo)}`, diff: c.diff, label: fieldLabel });
function renderSnaps() {
  const list = S.snapshots;
  $("#snapList").innerHTML = list.length ? list.map((s, i) => {
    const prev = list[i + 1];
    const tot = prev ? ` <span class="muted">(${s.total - prev.total >= 0 ? "+" : ""}${s.total - prev.total} vs. anterior)</span>` : "";
    return `<article class="card snap"><div class="head"><h3>${fmtMonth(s.ref_month)}</h3>
      <span class="muted">enviada por ${esc(s.uploaded_by)} · ${ago(s.uploaded_at)} · ${esc(s.filename)}</span></div>
      ${statGrid([[s.total, `unidades ativas${tot}`], ...(s.primeira ? [["—", "primeira carga (base)"]]
        : [[`+${s.novas}`, "novas", "g"], [`−${s.saidas}`, "saíram", "r"], [s.alteradas, "alteradas", "y"], [s.reativadas, "voltaram"]])])}
      <div class="chips">${Object.entries(s.by_tipo).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<span class="badge b-none">${esc(t)} ${n}</span>`).join("")}</div>
      <div style="margin-top:10px"><button class="btn sm" data-snapchg="${s.id}">Ver o que mudou</button></div>
      <div class="chglist" id="chg-${s.id}" hidden></div></article>`;
  }).join("") : `<div class="empty">Nenhuma planilha enviada ainda.<br>Clique em “Enviar planilha do mês” e escolha o Excel de unidades.</div>`;
}
async function toggleChanges(id) {
  const box = $("#chg-" + id);
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false; box.innerHTML = `<div class="empty">Carregando…</div>`;
  try {
    const r = await api(`/snapshots/${id}/changes`);
    const shown = r.changes.slice(0, 300);
    box.innerHTML = shown.length ? shown.map(chgHtml).join("") + (r.changes.length > 300 ? `<div class="muted">…mostrando 300 de ${r.changes.length}</div>` : "") : `<div class="empty">Sem mudanças registradas.</div>`;
  } catch (e) { box.innerHTML = esc(e.message); }
}
function openUpload() {
  pendingUpload = null;
  $("#upFile").value = ""; $("#upResult").innerHTML = ""; $("#errUpload").textContent = "";
  const d = new Date(); $("#upMonth").value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  $("#btnCommit").hidden = true; $("#btnAnalyze").textContent = "Analisar";
  $("#dlgUpload").showModal();
}
async function analyzeUpload(e) {
  e.preventDefault();
  const file = $("#upFile").files[0]; if (!file) return;
  const fd = new FormData(); fd.append("file", file); fd.append("ref_month", $("#upMonth").value);
  $("#errUpload").textContent = ""; $("#btnAnalyze").disabled = true; $("#btnAnalyze").textContent = "Analisando…";
  try {
    const r = await api("/import/preview", "POST", fd);
    pendingUpload = r;
    const sheets = Object.entries(r.sheets).map(([k, v]) => `${esc(k)}: ${v}`).join(" · ");
    $("#upResult").innerHTML = statGrid([[r.total, "unidades lidas"], ...(r.primeira ? [[r.novas, "serão cadastradas (primeira carga)", "g"]]
        : [[`+${r.novas}`, "novas", "g"], [`−${r.saidas}`, "saíram", "r"], [r.alteradas, "alteradas", "y"], [r.reativadas, "voltaram"], [r.sem_mudanca, "sem mudança"]])])
      + `<div class="muted">${sheets}</div>` + noticeHtml(r.warnings, { total: r.n_errors, lines: r.errors }) + (r.alerta_queda ? forceHtml("chkForce") : "")
      + (r.primeira ? "" : `<div class="chglist">${r.changes.map(chgHtml).join("") || `<div class="empty">Nenhuma diferença em relação à última atualização.</div>`}</div>`);
    $("#btnCommit").hidden = false; $("#btnAnalyze").textContent = "Analisar de novo";
  } catch (err) { pendingUpload = null; $("#errUpload").textContent = err.message; $("#btnCommit").hidden = true; $("#btnAnalyze").textContent = "Analisar"; }
  $("#btnAnalyze").disabled = false;
}
async function commitUpload() {
  const r = pendingUpload; if (!r) return;
  if (r.alerta_queda && !$("#chkForce")?.checked) { $("#errUpload").textContent = "Marque a confirmação do alerta de queda para continuar."; return; }
  $("#btnCommit").disabled = true;
  try {
    const out = await api("/import/commit", "POST", { token: r.token, ref_month: $("#upMonth").value, filename: r.filename, force: !!$("#chkForce")?.checked });
    $("#dlgUpload").close(); await load(true); show("atualizacoes");
    toast(`Planilha de ${fmtMonth($("#upMonth").value)} aplicada: ${out.total} unidades ativas.`);
  } catch (err) { $("#errUpload").textContent = err.message; }
  $("#btnCommit").disabled = false;
}

function incItem(i, D) {
  const u = D.unitById[i.unit_id];
  return `<article class="card oc"><div class="main">
    <div class="meta muted">${esc(u ? u.nome + " · " + u.uf : "?")}</div>
    <div class="t">${esc(i.titulo)}</div>
    ${i.descricao ? `<div class="d">${esc(i.descricao)}</div>` : ""}
    ${i.foto ? `<img class="oc-photo" src="${esc(i.foto)}" alt="Foto: ${esc(i.titulo)}" loading="lazy">` : ""}
    <div class="meta muted">${fmtDate(i.created_at)}</div></div>
    <div class="btns"><button class="btn sm" data-oc="${i.id}">Editar</button>
    <button class="btn sm danger ghost" data-remove-oc="${i.id}">Remover</button></div></article>`;
}

const TILES = [
  ["RR", 3, 1], ["AP", 5, 1],
  ["AM", 2, 2], ["PA", 3, 2], ["MA", 4, 2], ["CE", 5, 2], ["RN", 6, 2],
  ["AC", 1, 3], ["RO", 2, 3], ["TO", 3, 3], ["PI", 4, 3], ["PE", 5, 3], ["PB", 6, 3],
  ["MT", 2, 4], ["GO", 3, 4], ["BA", 4, 4], ["AL", 5, 4], ["SE", 6, 4],
  ["MS", 2, 5], ["DF", 3, 5], ["MG", 4, 5], ["ES", 5, 5],
  ["PR", 2, 6], ["SP", 3, 6], ["RJ", 4, 6],
  ["RS", 1, 7], ["SC", 2, 7],
];

const WIDGETS = {
  kpi_unidades: { title: "Unidades", size: 1, render: D => {
    const all = dashUnits(), vivas = all.filter(isLive).length;
    return kpi(vivas, "unidades ativas na rede", `${all.length - vivas} fechadas / inativas / saíram`, "", "unidades"); } },
  kpi_mudancas: { title: "Último upload", size: 1, render: () => {
    const s = S.snapshots[0];
    if (!s) return kpi("—", "nenhuma planilha enviada", "envie em Atualizações", "", "atualizacoes");
    if (s.primeira) return kpi(s.total, "primeira carga da planilha", fmtMonth(s.ref_month), "", "atualizacoes");
    return kpi(`+${s.novas} / −${s.saidas}`, "novas / saíram", `${fmtMonth(s.ref_month)} · ${s.alteradas} alteradas`, s.saidas ? "warn" : "", "atualizacoes"); } },
  mudancas: { title: "Novas e saídas do último upload", size: 2, render: () => {
    const rows = S.latest_changes.filter(c => c.kind !== "alterada").slice(0, 8);
    const lab = { nova: ["b-ok", "Nova"], saiu: ["b-critica", "Saiu"], reativada: ["b-baixa", "Voltou"] };
    return rows.length ? `<div class="list">${rows.map(c => `<div class="item" data-edit-unit="${c.unit_id}"><span class="badge ${lab[c.kind][0]}">${lab[c.kind][1]}</span>
      <div class="main"><div class="t">${esc(c.nome)}</div><div class="s">${esc(c.chave.split("|")[0])} · ${esc(tipoLabel(c.tipo))}</div></div></div>`).join("")}</div>`
      : `<div class="empty">Sem novas/saídas no último upload</div>`; } },
  evolucao: { title: "Evolução da rede (unidades ativas)", size: 2, render: () => {
    const byMonth = new Map();
    for (const s of [...S.snapshots].reverse()) byMonth.set(s.ref_month, s);      // ultima versao de cada mes
    const list = [...byMonth.values()].slice(-12);
    return list.length ? colChart(list.map((s, i) => ({ label: fmtMonth(s.ref_month), v: s.total, cur: i === list.length - 1 }))) : `<div class="empty">Envie a planilha em Atualizações para começar o histórico</div>`; } },
  aberturas_ano: { title: "Aberturas por ano", size: 2, render: () => {
    const m = openings("", "", dashSel), cy = new Date().getFullYear(), years = abYears(m, 8);
    return years.length ? colChart(years.map(y => ({ label: String(y), v: sum(m[y]), cur: y === cy }))) : `<div class="empty">Nenhuma unidade com data “desde”</div>`; } },
  aberturas_mes: { title: "Aberturas por mês: ano atual × anterior", size: 2, render: () => {
    const m = openings("", "", dashSel), cy = new Date().getFullYear(), cm = new Date().getMonth();
    const a = m[cy] || Array(12).fill(0), b = m[cy - 1] || Array(12).fill(0);
    const max = Math.max(...a, ...b, 1);
    return `<div class="cols">${MESES.map((mes, i) => `<div class="col"><div class="pair" title="${mes}: ${cy - 1} = ${b[i]} · ${cy} = ${i <= cm ? a[i] : "—"}">
      <i class="prev" style="height:${b[i] / max * 100}%"></i><i style="height:${(i <= cm ? a[i] : 0) / max * 100}%"></i></div><span class="m">${mes}</span></div>`).join("")}</div>
      <div class="legend"><span><i class="dot t-none"></i>${cy - 1} (${sum(b)})</span><span><i class="dot t-link"></i>${cy} (${sum(a)})</span></div>`; } },
  kpi_frank: { title: "Novas franquias", size: 1, render: () => pipeKpi() },
  pipe_fase: { title: "Novas franquias por fase atual", size: 1, render: () => pipeFaseBars() },
  pipe_golive: { title: "Próximos Go Lives (previsão)", size: 2, render: () => pipeGoLive() },
  kpi_sol: { title: "Solicitações", size: 1, render: () => solKpi() },
  sol_cat: { title: "Solicitações abertas por categoria", size: 1, render: () => solCatBars() },
  sol_antigas: { title: "Solicitações abertas há mais tempo", size: 2, render: () => solOldList() },
  sol_unidades: { title: "Unidades que mais nos acionam (90 dias)", size: 2, render: () => solUnidadesList() },
  por_consultor: { title: "Unidades por consultor de campo", size: 2, render: () =>
    bars(countBy(dashUnits().filter(u => isLive(u) && u.consultor), u => u.consultor).slice(0, 10)) },
  kpi_abertas: { title: "Ocorrências", size: 1, render: D =>
    kpi(D.incidents.length, "ocorrências publicadas", "ver publicações", "", "ocorrencias") },
  kpi_criticas: { title: "Críticas", size: 1, render: D => {
    const n = D.incidents.filter(i => i.severidade === "critica").length;
    return kpi(n, "ocorrências críticas", n ? "ver publicações" : "nenhuma publicação", n ? "hot" : "", "criticas"); } },
  kpi_semresp: { title: "Sem responsável", size: 1, render: D => {
    const n = dashUnits().filter(u => !u.responsavel).length;
    return kpi(n, "unidades sem responsável", n ? "complete o cadastro" : "tudo preenchido", n ? "warn" : "", "semresp"); } },
  urgentes: { title: "Últimas ocorrências", size: 2, render: D => {
    const rows = [...D.incidents].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id).slice(0, 7);
    return rows.length ? `<div class="list">${rows.map(i => incItem(i, D)).join("")}</div>` : `<div class="empty">Nenhuma ocorrência publicada</div>`; } },
  mapa: { title: "Mapa de pontos ativos", size: 2, render: D => {
    const byUf = {};
    for (const u of dashUnits().filter(isLive)) { byUf[u.uf] = (byUf[u.uf] || 0) + 1; }
    const max = Math.max(...Object.values(byUf), 0), total = sum(Object.values(byUf));
    const tiles = TILES.map(([uf, c, r]) => {
      const n = byUf[uf] || 0, heat = max ? n / max : 0;
      const rgb = [236 + (220 - 236) * heat, 236 * (1 - heat), 239 + (50 - 239) * heat];
      const linear = rgb.map(v => { const s = v / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; });
      const lum = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
      return `<button type="button" class="tile ${lum < .179 ? "heat-light" : ""}" style="grid-column:${c};grid-row:${r};--heat:${(heat * 100).toFixed(2)}%" data-uf="${uf}" title="${uf}: ${n} ponto(s) ativo(s)" aria-label="${uf}: ${n} pontos ativos. Ver pontos desta UF."><span>${uf}</span><small>${n}</small></button>`;
    }).join("");
    return `<div class="heat-summary"><strong>${total.toLocaleString("pt-BR")} <span>pontos ativos</span></strong><span>${Object.keys(byUf).length} UFs com pontos</span></div>
      <div class="tilemap">${tiles}</div><div class="heat-legend"><div><span>0 pontos</span><span>${max} pontos</span></div><div class="heat-scale"></div><p>Mais vermelho, maior concentração de pontos.<br>Selecione uma UF para ver seus pontos.</p></div>`; } },
  saude: { title: "Saúde da rede", size: 1, render: D => {
    const c = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const u of dashUnits().filter(isLive)) c[D.health[u.id].worst]++;
    const col = { 0: "var(--ok)", 1: "var(--baixa)", 2: "var(--media)", 3: "var(--alta)", 4: "var(--critica)" };
    const lab = { 0: "Sem ocorrências", 1: "Baixa", 2: "Média", 3: "Alta", 4: "Crítica" };
    return bars([0, 1, 2, 3, 4].map(k => ({ label: lab[k], n: c[k], color: col[k] }))); } },
  por_tipo: { title: "Unidades por tipo", size: 1, render: () => bars(countBy(dashUnits().filter(isLive), u => u.tipo).slice(0, 10).map(r => ({ ...r, label: r.label.length <= 3 && TIPO_LABEL[r.label] ? `${r.label} · ${TIPO_LABEL[r.label]}` : r.label }))) },
  por_categoria: { title: "Ocorrências por categoria", size: 2, render: D => bars(countBy(D.incidents, i => i.categoria).slice(0, 8), "var(--alta)") },
  por_uf: { title: "Unidades por UF", size: 2, render: () => bars(countBy(dashUnits().filter(isLive), u => u.uf).slice(0, 10).map(r => ({ ...r, attr: `data-uf="${esc(r.label)}"` }))) },
  atividade: { title: "Últimas atividades", size: 2, render: () => S.log.length
    ? `<div class="list">${S.log.slice(0, 7).map(l => `<div class="item" style="cursor:default"><div class="main"><div class="t">${esc(l.acao)}</div>
      <div class="s">${esc(l.detalhe)} · ${esc(l.user)} · ${ago(l.ts)}</div></div></div>`).join("")}</div>` : `<div class="empty">Sem atividades</div>` },
};
const DEFAULT_LAYOUT = [
  ["kpi_unidades", 1], ["kpi_abertas", 1], ["kpi_criticas", 1], ["kpi_mudancas", 1],
  ["urgentes", 2], ["mapa", 2], ["kpi_frank", 1], ["pipe_fase", 1], ["pipe_golive", 2], ["kpi_sol", 1], ["sol_cat", 1], ["sol_antigas", 2], ["sol_unidades", 2], ["aberturas_ano", 2], ["aberturas_mes", 2],
  ["saude", 1], ["por_tipo", 1], ["por_consultor", 2], ["evolucao", 2], ["por_categoria", 2],
  ["por_uf", 2], ["atividade", 2], ["mudancas", 2, true], ["kpi_semresp", 1, true],
].map(([id, span, hidden]) => ({ id, span, hidden: !!hidden }));

function loadLayout() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem("cf_layout") || "[]"); } catch (e) { console.warn("layout salvo inválido, usando o padrão:", e); }
  const known = saved.filter(w => WIDGETS[w.id]);
  for (const d of DEFAULT_LAYOUT) if (!known.some(w => w.id === d.id)) known.push({ ...d, hidden: d.hidden || saved.length > 0 });
  return known;
}
let layout = loadLayout();
const saveLayout = () => localStorage.setItem("cf_layout", JSON.stringify(layout));

/* filtro do painel: por padrão só os tipos que a equipe mais acompanha; "Todos" mostra a rede inteira */
const MAIN_TIPOS = ["CO", "LJ", "PA", "FL"];
let dashTipos = (() => { try { return JSON.parse(localStorage.getItem("cf_dash_tipos")); } catch (e) { return null; } })();   // null = principais | "all" | [tipos]
const dashSel = u => dashTipos === "all" || (Array.isArray(dashTipos) ? dashTipos : MAIN_TIPOS).includes(u.tipo);
const dashUnits = () => S.units.filter(dashSel);
function setDashTipos(v) { dashTipos = v; localStorage.setItem("cf_dash_tipos", JSON.stringify(v)); renderDash(); }
function renderDashFilter() {
  const tipos = [...new Set([...MAIN_TIPOS, ...S.units.map(u => u.tipo).filter(Boolean)])];
  const cur = dashTipos === "all" ? tipos : Array.isArray(dashTipos) ? dashTipos : MAIN_TIPOS;
  const live = t => S.units.filter(u => u.tipo === t && isLive(u)).length;
  $("#dashFilter").innerHTML = `<span class="muted">Mostrar:</span>` + tipos.map(t =>
    `<button class="fchip ${cur.includes(t) ? "on" : ""}" data-dtipo="${esc(t)}" title="${esc(tipoLabel(t))}">${esc(t)} <small>${live(t)}</small></button>`).join("") +
    `<span class="spacer"></span><button class="btn sm ghost" data-dpreset="main">Só CO · LJ · PA · FL</button><button class="btn sm ghost" data-dpreset="all">Todos</button>`;
}
$("#dashFilter").addEventListener("click", e => {
  const t = e.target.closest("[data-dtipo]")?.dataset.dtipo, p = e.target.closest("[data-dpreset]")?.dataset.dpreset;
  if (p) return setDashTipos(p === "all" ? "all" : null);
  if (!t) return;
  const all = [...new Set([...MAIN_TIPOS, ...S.units.map(u => u.tipo).filter(Boolean)])];
  const cur = dashTipos === "all" ? all : Array.isArray(dashTipos) ? dashTipos : MAIN_TIPOS;
  const next = cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t];
  setDashTipos(next.length ? next : null);
});

function renderDash() {
  if (dragging) return;
  const D = derive();
  D.open = D.open.filter(i => D.unitById[i.unit_id] && dashSel(D.unitById[i.unit_id]));
  D.incidents = D.incidents.filter(i => D.unitById[i.unit_id] && dashSel(D.unitById[i.unit_id]));
  renderDashFilter();
  const el = $("#dash");
  el.classList.toggle("editing", editing);
  el.innerHTML = layout.filter(w => !w.hidden).map(w => {
    const def = WIDGETS[w.id], isKpi = w.id.startsWith("kpi_");
    const hot = w.id === "kpi_criticas" && D.open.some(i => i.severidade === "critica");
    return `<div class="w s${w.span} ${hot ? "hot" : ""}" data-w="${w.id}" ${editing ? 'draggable="true"' : ""}>
      <div class="ctl"><button data-act="size" title="Tamanho">↔</button><button data-act="hide" title="Ocultar">✕</button></div>
      ${isKpi ? "" : `<h4>${esc(def.title)}</h4>`}<div class="body">${def.render(D)}</div></div>`;
  }).join("");
  const tray = $("#dashTray");
  tray.hidden = !editing;
  $("#editHint").hidden = !editing;
  $("#btnEditDash").innerHTML = editing ? `${ic("check")} Concluir` : `${ic("edit")} Personalizar painel`;
  if (editing) {
    const hidden = layout.filter(w => w.hidden);
    tray.innerHTML = `<strong>Cards disponíveis:</strong>` +
      (hidden.length ? hidden.map(w => `<button class="btn sm" data-add="${w.id}">${ic("plus")} ${esc(WIDGETS[w.id].title)}</button>`).join("") : `<span class="muted">todos já estão no painel</span>`) +
      `<span class="spacer"></span><button class="btn sm ghost" id="btnResetLayout">Restaurar padrão</button>`;
  }
}

/* ============ unidades ============ */
function renderUnits() {
  const D = derive();
  const q = norm($("#fUnitQ").value), uf = $("#fUnitUf").value, tipo = $("#fUnitTipo").value, sa = $("#fUnitSaude").value,
    cons = $("#fUnitConsultor").value;
  const list = S.units.filter(u => {
    const h = D.health[u.id];
    if (uf && u.uf !== uf) return false;
    if (tipo && u.tipo !== tipo) return false;
    if (cons && u.consultor !== cons) return false;
    if (q && !norm([u.nome, u.sigla, u.cidade, u.responsavel, u.franqueado, u.unidade_master, u.consultor, u.cnpj, u.razao_social, u.ponto, u.tipo,
      u.email, u.email_gestor, u.telefone, u.celular, u.endereco, u.bairro, u.cep].join(" ")).includes(q)) return false;
    if (sa === "viva" && !isLive(u)) return false;
    if (sa === "fechada" && isLive(u)) return false;
    if (sa === "solab" && !(S.sol_units[u.id] || {}).ab) return false;
    if (sa === "problema" && !h.open.length) return false;
    if (sa === "critica" && h.worst < 4) return false;
    if (sa === "ok" && h.open.length) return false;
    if (sa === "semresp" && u.responsavel) return false;
    return true;
  }).sort((a, b) => {
    const sort = $("#fUnitSort").value, sa = (S.sol_units[a.id] || {}).d90 || 0, sb = (S.sol_units[b.id] || {}).d90 || 0;
    if (sort === "nome") return a.nome.localeCompare(b.nome);
    if (sort === "solic") return sb - sa || a.nome.localeCompare(b.nome);
    return D.health[b.id].worst - D.health[a.id].worst || a.nome.localeCompare(b.nome);
  });
  $("#unitCount").textContent = `(${list.length}${list.length !== S.units.length ? " de " + S.units.length : ""})`;
  $("#btnMoreUnits").hidden = list.length <= unitLimit;
  $("#btnMoreUnits").textContent = `Mostrar mais (${Math.min(unitLimit, list.length)} de ${list.length})`;
  $("#units").innerHTML = list.length ? list.slice(0, unitLimit).map(u => {
    const h = D.health[u.id], live = isLive(u);
    const status = u.saiu_em ? `<span class="badge b-none">Saiu da planilha em ${fmtMonth(u.saiu_em)}</span>`
      : u.situacao === "fechada" ? `<span class="badge b-none">Fechada</span>` : u.situacao === "inativa" ? `<span class="badge b-none">Inativa</span>` : "";
    return `<article class="uc h-${sevName(h.worst)} ${live ? "" : "inativa"}">
      <div style="display:flex;gap:8px;justify-content:space-between"><span class="name">${esc(u.nome)}</span>${healthBadge(h.worst)}</div>
      <div class="meta">${[tipoLabel(u.tipo), u.sigla, u.uf, u.cidade, u.situacao === "implantacao" && "Em implantação"].filter(Boolean).map(esc).join(" · ")}</div>
      ${status}
      <div>${ic("user")} ${u.responsavel ? esc(u.responsavel) : '<span class="muted">sem responsável</span>'}</div>
      ${u.unidade_master ? `<div class="meta">Unidade responsável: <strong>${esc(u.unidade_master)}</strong></div>` : ""}
      ${u.consultor ? `<div class="meta">Consultor: ${esc(u.consultor)}</div>` : ""}
      ${u.desde ? `<div class="meta">aberta em ${fmtDate(u.desde)}</div>` : ""}
      ${(S.sol_units[u.id] || {}).tot ? `<div class="meta">Solicitações: <strong>${S.sol_units[u.id].d90}</strong> em 90 dias · ${S.sol_units[u.id].tot} no total${S.sol_units[u.id].ab ? ` · <strong>${S.sol_units[u.id].ab} aberta(s)</strong>` : ""}</div>` : ""}
      ${h.open.length ? `<div class="meta">${h.open.length} ocorrência(s) aberta(s): ${esc(h.open[0].titulo)}${h.open.length > 1 ? "…" : ""}</div>` : ""}
      <div class="foot"><button class="btn sm" data-edit-unit="${u.id}">Editar</button>
        <button class="btn sm danger" data-new-oc="${u.id}">${ic("plus")} Ocorrência</button></div></article>`;
  }).join("") : `<div class="empty">${S.units.length ? "Nenhuma unidade com esses filtros." : "Nenhuma unidade cadastrada ainda. Use “Nova unidade” ou “Importar”."}</div>`;
}

function fillFilters() {
  const ufs = [...new Set(S.units.map(u => u.uf))].sort(), tipos = [...new Set(S.units.map(u => u.tipo).filter(Boolean))].sort();
  fillSelect($("#fUnitUf"), ufs, { first: "Todas UFs" });
  fillSelect($("#fUnitTipo"), tipos, { first: "Todos os tipos", label: tipoLabel });
  fillSelect($("#fUnitConsultor"), [...new Set(S.units.map(u => u.consultor).filter(Boolean))].sort(), { first: "Todos consultores" });
  fillSelect($("#fAbUf"), ufs, { first: "Todas UFs" });
  $("#tiposList").innerHTML = [...new Set(["Franquia", "Hub", "Ponto de Coleta", ...S.units.map(u => u.tipo).filter(Boolean)])].map(t => `<option value="${esc(t)}">`).join("");
  $("#catsList").innerHTML = [...new Set([...DEFAULT_CATS, ...S.incidents.map(i => i.categoria)])].map(t => `<option value="${esc(t)}">`).join("");
}

/* ============ ocorrencias ============ */
function renderIncidents() {
  const D = derive(), q = norm($("#fOcQ").value), sv = $("#fOcSev").value;
  const list = S.incidents.filter(i => {
    const u = D.unitById[i.unit_id];
    return (!sv || i.severidade === sv) && (!q || norm([i.titulo, i.descricao, i.categoria, u && u.nome].join(" ")).includes(q));
  }).sort((a,b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  $("#ocCount").textContent = `(${list.length})`;
  $("#incidents").innerHTML = list.length ? list.map(i => {
    const u = D.unitById[i.unit_id];
    return `<article class="card oc"><div class="main">
      <div class="meta muted">${esc(u ? u.nome + " · " + u.uf : "?")}</div>
      <div class="t">${esc(i.titulo)}</div>
      ${i.descricao ? `<div class="d">${esc(i.descricao)}</div>` : ""}
      ${i.foto ? `<img class="oc-photo" src="${esc(i.foto)}" alt="Foto: ${esc(i.titulo)}" loading="lazy">` : ""}
      <div class="meta muted">${fmtDate(i.created_at)} · ${esc(i.created_by || "?")}</div>
      </div><div class="btns"><button class="btn sm" data-oc="${i.id}">Editar</button>
      <button class="btn sm danger ghost" data-remove-oc="${i.id}">Remover</button></div></article>`;
  }).join("") : '<div class="empty">Nenhuma ocorrência.</div>';
}

function renderLog() {
  $("#logList").innerHTML = S.log.length ? S.log.map(l => `<div class="logrow"><span class="when" title="${esc(l.ts)}">${ago(l.ts)}</span>
    <span><strong>${esc(l.acao)}</strong> — ${esc(l.detalhe)} <span class="muted">· ${esc(l.user)}</span></span></div>`).join("") : `<div class="empty">Sem atividades.</div>`;
}

/* ============ alertas globais ============ */
function renderAlerts() {
  const D = derive();
  const crit = D.open.filter(i => i.severidade === "critica").sort((a, b) => b.created_at.localeCompare(a.created_at));
  $("#alerts").innerHTML = crit.map(i => {
    const u = D.unitById[i.unit_id];
    return `<div class="alertLine"><span class="tag">CRÍTICO</span><strong>${esc(u ? u.nome : "?")}</strong><span>${esc(i.titulo)}</span>
      <span style="opacity:.8">${ago(i.created_at)}${u && u.responsavel ? " · resp.: " + esc(u.responsavel) : ""}</span><button data-oc="${i.id}">Abrir</button></div>`;
  }).join("");
  document.title = (crit.length ? `(${crit.length}) ` : "") + "Franchising - Team";
  const nOpen = D.open.length;
  const b = $("#badgeOc"); b.textContent = nOpen; b.dataset.n = nOpen;
  $("#netSummary").textContent = `${S.units.filter(isLive).length} pontos ativos · ${nOpen} ocorrência(s) em aberto`;

  const ids = new Set(crit.map(i => i.id));
  if (seenCrit) for (const i of crit) if (!seenCrit.has(i.id)) {
    const u = D.unitById[i.unit_id];
    toast(`${ic("alert")} <strong>Nova ocorrência crítica</strong><br>${esc(u ? u.nome : "?")}: ${esc(i.titulo)}`, true);
  }
  seenCrit = ids;
}

function toast(html, crit) {
  const t = document.createElement("div");
  t.className = "toast" + (crit ? " crit" : "");
  t.innerHTML = html;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), crit ? 15000 : 4000);
}

function renderAll() {
  renderAlerts(); fillFilters(); renderDash(); renderUnits(); renderIncidents(); renderLog(); renderAb(); renderSnaps(); fillPipeFilters(); renderPipe(); renderSol();
}

let stateLoading = null;
async function load(force) {
  while (stateLoading) {
    await stateLoading;
    if (!force) return;
  }
  stateLoading = loadState(force);
  try { await stateLoading; } finally { stateLoading = null; }
}
async function loadState(force) {
  try {
    const data = await api("/state");
    const j = JSON.stringify([data.units, data.incidents, data.log, data.snapshots, data.pipeline, data.sol, data.sol_units]);
    S = data;
    lastRev = [data.log[0]?.id || 0, data.units.length, data.incidents.length, data.snapshots[0]?.id || 0].join("|");
    if (force) { solFinKey = ""; solRankKey = ""; }          // alteração local: refaz as listas de finalizadas e o ranking
    if (force || j !== lastJson) { lastJson = j; renderAll(); }
  } catch (e) { console.warn(e); toast(esc("Não foi possível atualizar os dados: " + e.message)); }
}

/* ============ navegacao ============ */
function show(view) {
  if (view !== "pipeline" && typeof expandPipeline === "function") expandPipeline(false);
  currentView = view;
  $$("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + view));
  window.scrollTo(0, 0);
  if (view === "masters") loadMasters();
}
function go(where, extra) {
  if (where === "unidades" || where === "semresp") { show("unidades"); $("#fUnitSaude").value = where === "semresp" ? "semresp" : ""; $("#fUnitUf").value = ""; renderUnits(); }
  else if (where === "atualizacoes" || where === "aberturas" || where === "pipeline" || where === "solicitacoes") show(where);
  else if (where === "ocorrencias") { show("ocorrencias"); $("#fOcSev").value = ""; renderIncidents(); }
  else if (where === "criticas") { show("ocorrencias"); $("#fOcSev").value = "critica"; renderIncidents(); }
}

/* ============ modais ============ */
function unitOptions(sel, selected) {
  fillSelect(sel, [...S.units].sort((a, b) => a.nome.localeCompare(b.nome)), { first: "Selecione…", value: u => u.id, label: u => `${u.nome} (${u.uf})`, selected: selected ?? "" });
}

const UNIT_FORM_COLS = ["sigla", "ponto", "aeroporto", "desde", "cnpj", "razao_social", "franqueado", "unidade_master", "equipe", "consultor", "email", "email_gestor", "telefone", "celular", "endereco", "bairro", "cep"];
/* prefill: valores iniciais de uma unidade nova (ex.: candidato do pipeline de aberturas); aberturaId liga a unidade ao candidato */
function openUnit(id, prefill, aberturaId) {
  const f = $("#formUnit"), u = S.units.find(x => x.id == id);
  fillSelect(f.uf, S.ufs);
  f.reset();
  const src = u || prefill || {};
  for (const k of ["nome", "tipo", "uf", "cidade", "responsavel", "situacao", ...UNIT_FORM_COLS]) if (f[k] && src[k]) f[k].value = k === "desde" ? String(src[k]).slice(0, 10) : src[k];
  $("#unitCad").open = !!prefill;
  f.dataset.id = u ? u.id : ""; f.dataset.ab = aberturaId || "";
  const det = $("#unitDetail"), solBox = $("#unitSolsBox"); det.hidden = true; det.open = true; solBox.hidden = true;
  if (u) {
    api("/units/" + u.id).then(d => {
      if (u.origem === "planilha") {
        const rows = Object.keys(FIELD_LABEL).filter(k => d[k] && !["nome", "situacao"].includes(k)).map(k => [FIELD_LABEL[k], k === "desde" ? fmtDate(d[k]) : d[k]])
          .concat(Object.entries(d.extra || {}));
        if (d.saiu_em) rows.unshift(["Saiu da planilha em", fmtMonth(d.saiu_em)]);
        $("#unitDetailBody").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
        det.hidden = false;
      }
      if (d.solicitacoes.length) {
        const abertas = d.solicitacoes.filter(s => !s.final).length;
        $("#unitSolsSum").textContent = `Solicitações desta unidade (${d.solicitacoes.length}${abertas ? `, ${abertas} aberta(s)` : ""})`;
        $("#unitSols").innerHTML = d.solicitacoes.map(s => `<div class="item" data-sol="${s.id}"><span class="badge ${s.final ? "b-ok" : "b-media"}">${esc(s.etapa)}</span>
          <div class="main"><div class="t">${esc(s.titulo)}</div><div class="s">${esc(s.categoria)} · ${fmtDate(s.criado_em)}${s.final ? ` · fechada em ${Math.max(0, Math.floor((new Date(s.finalizado_em) - new Date(s.criado_em)) / 864e5))} d` : ""}</div></div></div>`).join("");
        solBox.hidden = false;
      }
    }).catch(err => console.warn("detalhe da unidade:", err));
  }
  $("#dlgUnitTitle").textContent = u ? "Editar unidade" : "Nova unidade";
  $("#btnDelUnit").hidden = !u;
  $("#errUnit").textContent = "";
  $("#dlgUnit").showModal();
}

function openOc(id, unitId) {
  const f = $("#formOc"), i = S.incidents.find(x => x.id == id);
  if (!S.units.length) { toast("Cadastre uma unidade primeiro."); return; }
  f.reset();
  unitOptions(f.unit_id, i ? i.unit_id : unitId);
  if (i) for (const k of ["titulo", "categoria", "severidade", "descricao"]) f[k].value = i[k];
  f.dataset.id = i ? i.id : "";
  $("#ocFotoPreview").hidden = !i?.foto;
  $("#ocFotoPreview").src = i?.foto || "";
  $("#ocRemoveFotoLabel").hidden = !i?.foto;
  $("#dlgOcTitle").textContent = i ? "Editar ocorrência" : "Nova ocorrência";
  $("#btnDelOc").hidden = !i;
  $("#errOc").textContent = "";
  $("#dlgOc").showModal();
}

async function submitForm(form, errEl, base, dlg, extra = {}) {
  const data = Object.fromEntries(new FormData(form));
  const id = form.dataset.id;
  try {
    await api(`${base}${id ? "/" + id : ""}`, id ? "PUT" : "POST", { ...data, ...extra });
    dlg.close(); await load(true);
    toast(id ? "Alterações salvas." : "Cadastrado com sucesso.");
  } catch (e) { errEl.textContent = e.message; }
}

/* ============ CSV ============ */
function splitCsv(line, d) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === d) { out.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  out.push(cur.trim()); return out;
}
function parseUnits(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const d = [";", "\t", ","].map(x => [x, lines[0].split(x).length]).sort((a, b) => b[1] - a[1])[0][0];
  let rows = lines.map(l => splitCsv(l, d));
  let cols = ["nome", "tipo", "uf", "responsavel", "cidade"];
  const first = rows[0].map(norm);
  if (first.includes("nome") || first.includes("uf")) {            // cabecalho
    cols = first.map(h => ({ "responsável": "responsavel", "estado": "uf", "municipio": "cidade" }[h] || h));
    rows = rows.slice(1);
  }
  return rows.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ""])));
}
async function exportXlsx() {                           // Excel completo, gerado no servidor (todas as colunas)
  try {
    const res = await fetch("/api/units/export", { headers: { "X-User": encodeURIComponent(user), "X-Access-Code": code } });
    if (!res.ok) throw new Error(res.status === 404 ? "servidor desatualizado: reinicie o iniciar.bat" : `erro ${res.status}`);
    const a = document.createElement("a"); a.href = URL.createObjectURL(await res.blob());
    a.download = `unidades-completo-${new Date().toISOString().slice(0, 10)}.xlsx`; a.click(); URL.revokeObjectURL(a.href);
  } catch (e) { toast("Não consegui exportar: " + esc(e.message)); }
}
/* ============ eventos ============ */
document.addEventListener("click", async e => {
  const t = e.target.closest("button, [data-oc], [data-go], [data-uf], [data-add], [data-quick], [data-edit-unit]");
  if (!t) return;
  if (t.matches("[data-close]")) return t.closest("dialog").close();
  if (editing && t.closest(".w") && !t.closest(".ctl") && !t.dataset.add) return;

  if (t.dataset.view) return show(t.dataset.view);
  if (t.dataset.act && t.closest(".w")) {
    const w = layout.find(x => x.id === t.closest(".w").dataset.w);
    if (t.dataset.act === "size") w.span = w.span === 1 ? 2 : w.span === 2 ? 4 : 1;
    else w.hidden = true;
    saveLayout(); return renderDash();
  }
  if (t.dataset.add) { const w = layout.find(x => x.id === t.dataset.add); w.hidden = false; saveLayout(); return renderDash(); }
  if (t.id === "btnResetLayout") { layout = DEFAULT_LAYOUT.map(x => ({ ...x })); saveLayout(); return renderDash(); }
  if (t.dataset.go) return go(t.dataset.go);
  if (t.dataset.uf) { show("unidades"); $("#fUnitUf").value = t.dataset.uf; $("#fUnitSaude").value = ""; return renderUnits(); }
  if (t.dataset.removeOc) {
    if (!confirm("Remover esta ocorrência?")) return;
    try { await api("/incidents/" + t.dataset.removeOc, "DELETE"); await load(true); }
    catch (err) { toast(esc(err.message)); }
    return;
  }
  if (t.dataset.oc) return openOc(t.dataset.oc);
  if (t.dataset.editUnit) return openUnit(t.dataset.editUnit);
  if (t.dataset.snapchg) return toggleChanges(t.dataset.snapchg);
  if (t.dataset.newOc) return openOc(null, t.dataset.newOc);
  switch (t.id) {
    case "btnNewOc": return openOc();
    case "btnNewUnit": return openUnit();
    case "btnEditDash": editing = !editing; return renderDash();
    case "btnImport": $("#importText").value = ""; $("#errImport").textContent = ""; return $("#dlgImport").showModal();
    case "btnExport": return exportXlsx();
    case "btnUpload": return openUpload();
    case "btnCommit": return commitUpload();
    case "btnMoreUnits": unitLimit += 200; return renderUnits();
    case "btnTheme": {
      const dark = document.documentElement.dataset.theme !== "dark";
      document.documentElement.dataset.theme = dark ? "dark" : "light"; localStorage.setItem("cf_theme", dark ? "dark" : "light"); return;
    }
    case "btnUser": await askName(); showUser(); return;
    case "btnDelUnit": {
      const id = $("#formUnit").dataset.id;
      if (!confirm("Excluir esta unidade e TODAS as ocorrências dela?")) return;
      try { await api(`/units/${id}`, "DELETE"); $("#dlgUnit").close(); await load(true); } catch (err) { $("#errUnit").textContent = err.message; }
      return;
    }
    case "btnDelOc": {
      const id = $("#formOc").dataset.id;
      if (!confirm("Excluir esta ocorrência?")) return;
      try { await api(`/incidents/${id}`, "DELETE"); $("#dlgOc").close(); await load(true); } catch (err) { $("#errOc").textContent = err.message; }
      return;
    }
  }
});

$("#formUnit").addEventListener("submit", e => { e.preventDefault(); submitForm(e.target, $("#errUnit"), "/units", $("#dlgUnit"), e.target.dataset.ab ? { abertura_id: e.target.dataset.ab } : {}); });
function readOcPhoto(file) {
  return new Promise((resolve, reject) => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024) {
      reject(new Error("Use PNG, JPEG ou WebP de até 2 MB.")); return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Erro ao ler a foto."));
    reader.readAsDataURL(file);
  });
}
$("#ocFoto").addEventListener("change", async e => {
  $("#errOc").textContent = "";
  const old = S.incidents.find(i => i.id == $("#formOc").dataset.id), preview = $("#ocFotoPreview");
  preview.src = old?.foto || ""; preview.hidden = !old?.foto;
  if (!e.target.files[0]) return;
  try { preview.src = await readOcPhoto(e.target.files[0]); preview.hidden = false; $("#ocRemoveFoto").checked = false; }
  catch (err) { e.target.value = ""; $("#errOc").textContent = err.message; }
});
$("#ocRemoveFoto").addEventListener("change", e => {
  $("#ocFotoPreview").hidden = e.target.checked || !$("#ocFotoPreview").getAttribute("src");
});
$("#formOc").addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.target, button = form.querySelector('[type="submit"]'); button.disabled = true;
  try {
    const old = S.incidents.find(i => i.id == form.dataset.id), file = $("#ocFoto").files[0];
    const foto = $("#ocRemoveFoto").checked ? "" : file ? await readOcPhoto(file) : old?.foto || "";
    await submitForm(form, $("#errOc"), "/incidents", $("#dlgOc"), { foto, ...(old ? { status: old.status } : {}) });
  } catch (err) { $("#errOc").textContent = err.message; }
  finally { button.disabled = false; }
});
$("#importFile").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  if (/\.xls[xm]$/i.test(f.name)) {                                  // Excel -> fluxo da planilha mensal (com comparacao)
    $("#dlgImport").close(); openUpload(); $("#upFile").files = e.target.files; $("#formUpload").requestSubmit(); return;
  }
  if (/\.xls$/i.test(f.name)) { $("#errImport").textContent = "Arquivo .xls antigo: abra no Excel e salve como .xlsx."; return; }
  $("#importText").value = await f.text();
});
$("#formImport").addEventListener("submit", async e => {
  e.preventDefault();
  const rows = parseUnits($("#importText").value);
  if (!rows.length) { $("#errImport").textContent = "Nada para importar."; return; }
  try {
    let imported = 0; const erros = [];
    for (let i = 0; i < rows.length; i += 500) {                      // em lotes: sem limite pratico de linhas
      $("#errImport").textContent = `Importando… ${Math.min(i + 500, rows.length)} de ${rows.length}`;
      const r = await api("/units/bulk", "POST", { rows: rows.slice(i, i + 500), offset: i });
      imported += r.importadas; erros.push(...r.erros);
    }
    if (erros.length) { $("#errImport").innerHTML = `${imported} importadas. ${erros.length} com problema:<br>` + erros.slice(0, 40).map(esc).join("<br>"); await load(true); return; }
    $("#dlgImport").close(); await load(true); toast(`${imported} unidades importadas.`);
  } catch (err) { $("#errImport").textContent = err.message; }
});
["fUnitQ", "fUnitUf", "fUnitTipo", "fUnitSaude", "fUnitConsultor", "fUnitSort"].forEach(id => $("#" + id).addEventListener("input", () => { unitLimit = 120; renderUnits(); }));
["fAbUf", "fAbAnos"].forEach(id => $("#" + id).addEventListener("input", renderAb));
$("#formUpload").addEventListener("submit", analyzeUpload);
["upFile", "upMonth"].forEach(id => $("#" + id).addEventListener("input", () => { pendingUpload = null; $("#btnCommit").hidden = true; $("#btnAnalyze").textContent = "Analisar"; }));
["fOcQ", "fOcSev"].forEach(id => $("#" + id).addEventListener("input", renderIncidents));

/* drag & drop dos cards (modo personalizar) */
const dash = $("#dash");
dash.addEventListener("dragstart", e => { const w = e.target.closest(".w"); if (!w) return; dragging = true; e.dataTransfer.setData("text/plain", w.dataset.w); e.dataTransfer.effectAllowed = "move"; });
dash.addEventListener("dragover", e => { const w = e.target.closest(".w"); if (!w) return; e.preventDefault(); $$(".dragover").forEach(x => x.classList.remove("dragover")); w.classList.add("dragover"); });
dash.addEventListener("drop", e => {
  e.preventDefault();
  const to = e.target.closest(".w"), from = e.dataTransfer.getData("text/plain");
  dragging = false;
  if (to && from && to.dataset.w !== from) {
    const a = layout.findIndex(x => x.id === from), [item] = layout.splice(a, 1);
    layout.splice(layout.findIndex(x => x.id === to.dataset.w), 0, item);
    saveLayout();
  }
  renderDash();
});
dash.addEventListener("dragend", () => { dragging = false; renderDash(); });

/* ============ inicio ============ */
(async function init() {
  if (localStorage.getItem("cf_theme") === "dark") document.documentElement.dataset.theme = "dark";
  if (!user) await askName();
  showUser();
  try { const p = await api("/ping"); if (p.version !== EXPECTED_VERSION) $("#verBanner").hidden = false; } catch (e) { console.warn("ping:", e); }
  await load(true);
  let polling = false;
  const poll = async () => {
    if (polling || stateLoading || document.hidden) return;
    polling = true;
    try { const r = await api("/rev"); if (r.rev !== lastRev) await load(); } catch (e) { console.warn("sincronização:", e); }
    finally { polling = false; }
  };
  await poll();
  setInterval(poll, 10000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
})();
