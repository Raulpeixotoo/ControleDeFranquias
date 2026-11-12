"use strict";
/* Visões extras da aba Novas franquias: Planilha (estilo Excel) e Solicitações aos franqueados + prioridade.
   Depende de app.js e pipeline.js (pipeAll, pipeModel, interp, saveValor, renderPipe, priBadge, PRI_OPTS...). */

let gridFocus = localStorage.getItem("cf_gridfocus") || "first";
let gridIdent = localStorage.getItem("cf_gridident") === "1";
const NIVEL = { alta: 1, media: 2, baixa: 3 };
const pad2 = n => String(n).padStart(2, "0");

/* ---------- prioridade ---------- */
async function setPrioridade(abId, p) {
  const ab = S.pipeline.aberturas.find(a => a.id == abId); if (!ab) return;
  try { await api(`/aberturas/${ab.id}/prioridade`, "PUT", { prioridade: p }); ab.prioridade = p; renderPipe(); toast(p ? `Prioridade: ${PRI_LABEL[p]}` : "Prioridade removida"); }
  catch (e) { toast("Não salvou: " + esc(e.message)); }
}

/* ---------- Planilha ---------- */
const runs = (arr, key) => { const out = []; for (const x of arr) { const k = key(x); if (out.length && out[out.length - 1].k === k) out[out.length - 1].n++; else out.push({ k, n: 1 }); } return out; };

function gridText(c, raw) {
  const s = interp(raw);
  if (s === "vazio") return "";
  if (s === "pend") return "–";
  if (s === "na") return "n/a";
  if (c.kind === "data" && isoDate(raw)) return `${raw.slice(8, 10)}/${raw.slice(5, 7)}/${raw.slice(2, 4)}`;
  if (norm(raw) === "ok") return "✓";
  return raw.length > 22 ? raw.slice(0, 21) + "…" : raw;
}

function renderGrid(M, list) {
  const selected = gridFocus === "all" ? "all" : M.fases.some(f => String(f.id) === gridFocus) ? gridFocus : String(M.fases[0]?.id || "");
  const fases = selected === "all" ? M.fases : M.fases.filter(f => String(f.id) === selected);
  const cols = gridIdent ? M.ident.map(c => ({ c, id: true })) : [];
  const phaseCols = fases.map(f => ({ f, cs: M.byFase[f.id] }));
  const bar = `<div class="gridbar pipeline-grid-controls"><label>Fase na planilha<select id="gridFocus"><option value="all" ${selected === "all" ? "selected" : ""}>Todas as fases</option>${M.fases.map(f => `<option value="${f.id}" ${String(f.id) === selected ? "selected" : ""}>${esc(f.nome)}</option>`).join("")}</select></label>
    <label class="chk"><input type="checkbox" id="gridIdent" ${gridIdent ? "checked" : ""}> Dados do candidato</label>
    <span class="muted">Clique na célula para editar. Use a rolagem da planilha para ver os demais campos.</span></div>`;
  // cabecalho em 3 linhas: fases / tipos / campos
  const r1 = `<th rowspan="3" class="sticky1">Prioridade</th><th rowspan="3" class="sticky2">Localidade</th><th rowspan="3">UF</th><th rowspan="3">Fase atual</th><th rowspan="3">%</th>`
    + (cols.length ? `<th colspan="${cols.length}" class="band id">Identificação</th>` : "")
    + phaseCols.map(({ f, cs }) => `<th colspan="${Math.max(1, cs.length)}" class="band b${M.fases.indexOf(f) % 4}">${esc(f.nome)}</th>`).join("");
  const typeRuns = cs => runs(cs, c => M.tipoName[c.tipo_id] || "").map(r => `<th colspan="${r.n}" class="tp">${esc(r.k)}</th>`).join("");
  const r2 = (cols.length ? typeRuns(cols.map(x => x.c)) : "") + phaseCols.map(({ cs }) => cs.length ? typeRuns(cs) : `<th class="tp"></th>`).join("");
  const r3 = cols.map(x => `<th title="${esc(x.c.label)}">${esc(x.c.label)}</th>`).join("") + phaseCols.map(({ cs }) => cs.map(c => `<th title="${esc(c.label)}">${esc(c.label)}</th>`).join("") || '<th>Sem campos</th>').join("");

  const body = list.map(({ ab, c }) => {
    const idTds = cols.map(({ c: cp }) => `<td class="g g-id" data-gab="${ab.id}" data-gcampo="${cp.id}" title="${esc(ab.v[cp.id] || "")}">${esc((ab.v[cp.id] || "").slice(0, 30))}</td>`).join("");
    const phTds = phaseCols.map(({ cs }) => cs.map(cp => {
      const raw = ab.v[cp.id] || "", s = interp(raw);
      return `<td class="g g-${s}" data-gab="${ab.id}" data-gcampo="${cp.id}" title="${esc(cp.label)}: ${esc(raw)}">${esc(gridText(cp, raw))}</td>`;
    }).join("") || '<td>—</td>').join("");
    return `<tr class="st-${c.status}"><td class="sticky1"><select class="pri-sel pri-${ab.prioridade || ""}" data-gpri="${ab.id}">${priOptions(ab.prioridade)}</select></td>
      <td class="sticky2"><button class="nm" data-ab="${ab.id}" title="Abrir detalhe">${esc(ab.nome)}</button></td><td>${esc(ab.uf)}</td>
      <td>${c.cur ? esc(c.cur.f.nome) : c.status === "concluida" ? "Concluída" : c.standby ? "Stand-by" : "—"}</td><td style="text-align:right">${c.overall}%</td>${idTds}${phTds}</tr>`;
  }).join("");
  $("#pipeGrid").innerHTML = bar + (list.length
    ? `<div class="gscroll"><table class="pg"><thead><tr>${r1}</tr><tr>${r2}</tr><tr>${r3}</tr></thead><tbody>${body}</tbody></table></div>`
    : `<div class="empty">Nenhum candidato com esses filtros.</div>`);
}

function gridCtl(c, raw) {
  if (c.kind === "status") {
    const known = STATUS_OPTS.some(([v]) => v.toLowerCase() === String(raw).toLowerCase());
    return `<select data-gedit>${STATUS_OPTS.map(([v, l]) => `<option value="${esc(v)}" ${String(raw).toLowerCase() === v.toLowerCase() ? "selected" : ""}>${l}</option>`).join("")}${!known ? `<option value="${esc(raw)}" selected>${esc(raw)}</option>` : ""}</select>`;
  }
  if (c.kind === "data") return `<input type="date" data-gedit value="${isoDate(raw) ? raw : ""}"><button type="button" class="btn sm ghost mini" data-gsetv="n/a">n/a</button><button type="button" class="btn sm ghost mini" data-gsetv="">✕</button>`;
  return `<input type="text" data-gedit value="${esc(raw)}" maxlength="500">`;
}

/* ---------- Solicitações aos franqueados ---------- */
function reqItems(ab, M) {
  const out = [];
  for (const c of M.P.campos) {
    if (!c.pedir || !c.fase_id) continue;
    const raw = ab.v[c.id] || "", s = interp(raw);
    if (s === "ok" || s === "na") continue;
    const m = String(raw).match(/solicitado\s+(\d{2})\/(\d{2})\/(\d{4})/i);
    out.push({ c, s, raw, when: m ? new Date(+m[3], +m[2] - 1, +m[1]) : null });
  }
  return out.sort((a, b) => (NIVEL[a.c.nivel] || 2) - (NIVEL[b.c.nivel] || 2) || a.c.ordem - b.c.ordem);
}
const COBRAR_DIAS = 7;

function renderReq(M, list) {
  const data = list.map(r => ({ ...r, items: reqItems(r.ab, M) })).filter(r => r.items.length);
  const all = data.flatMap(r => r.items), sol = all.filter(i => i.when), cobrar = sol.filter(i => daysSince(i.when) >= COBRAR_DIAS);
  const head = `<div class="muted" style="margin-bottom:10px">${all.length} item(ns) a pedir em ${data.length} candidato(s) ·
    ${sol.length} já solicitado(s) · <strong class="${cobrar.length ? "down" : ""}">${cobrar.length} para cobrar (${COBRAR_DIAS}+ dias sem resposta)</strong>.
    Os campos “pedir ao franqueado” e o nível de cada um são definidos em Configurar pipeline.</div>`;
  $("#pipeReq").innerHTML = head + (data.length ? data.map(({ ab, c, items }) => {
    const who = ab.v[M.papel.candidato] || "", fone = ab.v[M.papel.celular] || "";
    return `<article class="rq p-${ab.prioridade || ""}">
      <div class="rqhead">${priBadge(ab.prioridade)}<span class="name">${esc(ab.nome)}</span><span class="badge b-none">${esc(ab.uf)}</span>
        <span class="muted">${ic("user")} ${esc(who || "sem candidato")}${fone ? " · " + esc(fone) : ""} · ${c.cur ? esc(c.cur.f.nome) : ""}</span><span class="spacer"></span>
        <button class="btn sm" data-rq-copy="${ab.id}">${ic("copy")} Copiar pedido</button>
        <button class="btn sm primary" data-rq-mark="${ab.id}">Marcar como solicitado</button>
        <button class="btn sm ghost" data-ab="${ab.id}">Abrir</button></div>
      <div class="rqitems">${items.map(i => {
        const dias = i.when ? Math.round(daysSince(i.when)) : null, old = dias !== null && dias >= COBRAR_DIAS;
        return `<span class="chip nv-${i.c.nivel} ${i.when ? (old ? "cobrar" : "sol") : ""}" title="Prioridade do pedido: ${esc(i.c.nivel)}">${esc(i.c.label)}${i.when ? ` <em>solicitado há ${dias} d${old ? " — cobrar" : ""}</em>` : ""}${i.s === "bloq" ? " <em>negado</em>" : ""}</span>`;
      }).join("")}</div></article>`;
  }).join("") : `<div class="empty">Nada a solicitar com esses filtros.<br><span class="muted">(ou nenhum campo está marcado como “pedir” na configuração)</span></div>`);
}

function reqText(ab, M, items) {
  const who = (ab.v[M.papel.candidato] || "").split(/[\/,]/)[0].trim();
  return `Olá${who ? ", " + who : ""}! Para avançarmos com a abertura da unidade ${ab.nome} (${ab.uf}), precisamos que você nos envie:\n\n`
    + items.map(i => `• ${i.c.label}`).join("\n") + `\n\nQualquer dúvida, é só falar. Obrigado!`;
}
async function copyReq(abId) {
  const { M } = pipeAll(), ab = M.P.aberturas.find(a => a.id == abId), items = reqItems(ab, M);
  const text = reqText(ab, M, items);
  try { await navigator.clipboard.writeText(text); toast(`Pedido copiado (${items.length} itens). É só colar no WhatsApp ou e-mail.`); }
  catch { prompt("Copie o texto abaixo (Ctrl+C):", text); }
}
async function markRequested(abId) {
  const { M } = pipeAll(), ab = M.P.aberturas.find(a => a.id == abId);
  const novos = reqItems(ab, M).filter(i => i.s === "vazio" || i.s === "pend");
  if (!novos.length) return toast("Nada novo para marcar: tudo já foi solicitado.");
  const d = new Date(), ds = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  for (const i of novos) await saveValor(i.c.id, `Solicitado ${ds}`, abId);
  toast(`${novos.length} item(ns) marcados como solicitados em ${ds}.`);
}

/* ---------- eventos ---------- */
document.addEventListener("click", e => {
  const mode = e.target.closest("#pipeMode button");
  if (mode) { pipeMode = mode.dataset.mode; localStorage.setItem("cf_pipemode", pipeMode); renderPipe(); return; }
  const copy = e.target.closest("[data-rq-copy]"); if (copy) { copyReq(copy.dataset.rqCopy); return; }
  const mark = e.target.closest("[data-rq-mark]"); if (mark) { markRequested(mark.dataset.rqMark); return; }
  const setv = e.target.closest("#pipeGrid [data-gsetv]");
  if (setv) { const td = setv.closest("td"); saveValor(td.dataset.gcampo, setv.dataset.gsetv, td.dataset.gab); return; }
  const td = e.target.closest("#pipeGrid td[data-gcampo]");                   // clicar na celula = editar
  if (td && !td.querySelector("input,select")) {
    const M = pipeModel(), c = M.P.campos.find(x => x.id == td.dataset.gcampo), ab = M.P.aberturas.find(a => a.id == td.dataset.gab);
    td.innerHTML = gridCtl(c, ab.v[c.id] || "");
    const ctl = td.querySelector("input,select"); ctl.focus();
  }
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.matches("#pipeGrid [data-gedit]")) { const td = t.closest("td"); saveValor(td.dataset.gcampo, t.value.trim(), td.dataset.gab); return; }
  if (t.matches("[data-gpri]")) { setPrioridade(t.dataset.gpri, t.value); return; }
  if (t.id === "gridFocus") { gridFocus = t.value; localStorage.setItem("cf_gridfocus",gridFocus); renderPipe(); }
  if (t.id === "gridIdent") { gridIdent = t.checked; localStorage.setItem("cf_gridident",gridIdent ? "1" : "0"); renderPipe(); }
});
document.addEventListener("focusout", e => {                                  // saiu da celula sem alterar: volta ao texto
  if (!e.target.closest("#pipeGrid td[data-gcampo]")) return;
  setTimeout(() => { const a = document.activeElement; if (!a || !a.closest || !a.closest("#pipeGrid td[data-gcampo]")) renderPipe(); }, 180);
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && e.target.closest && e.target.closest("#pipeGrid td[data-gcampo]")) renderPipe(); });
