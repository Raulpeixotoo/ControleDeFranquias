// Smoke de interface via Chrome headless (CDP, sem dependências). Uso: node tests/ui_smoke.mjs <url> <pasta-de-screenshots|-> <unidades.xlsx> <abertura.xlsx>
// (normalmente chamado por tests/run_ui_smoke.py, que sobe o servidor com banco temporário)
// Percorre todas as abas, abre os diálogos principais, cria/finaliza uma solicitação e falha se houver erro de JavaScript.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2], shots = process.argv[3] && process.argv[3] !== "-" ? process.argv[3] : null, unitsXlsx = process.argv[4], aberturaXlsx = process.argv[5];
const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
if (!chrome) { console.log("FAIL  nenhum Chrome/Edge encontrado"); process.exit(2); }
if (shots) mkdirSync(shots, { recursive: true });

const proc = spawn(chrome, ["--headless=new", "--remote-debugging-port=9340", `--user-data-dir=${mkdtempSync(join(tmpdir(), "smoke-"))}`,
  "--window-size=1440,1000", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let targets;
for (let i = 0; i < 40; i++) { try { targets = await (await fetch("http://127.0.0.1:9340/json")).json(); if (targets.length) break; } catch { } await sleep(250); }
const ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
let seq = 0; const pending = new Map(), jsErrors = [];
ws.addEventListener("message", m => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result ?? d.error); pending.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") jsErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") jsErrors.push("console.error: " + d.params.args.map(a => a.value ?? a.description).join(" "));
});
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async expr => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);      // erro no teste não pode virar "undefined"
  return r.result?.value;
};
const waitFor = async (expr, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(120); } return false; };
const shot = async name => { if (!shots) return; const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }); writeFileSync(join(shots, name + ".png"), Buffer.from(r.data, "base64")); };

const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`); };
const nav = async v => { await ev(`document.querySelector('[data-view="${v}"]').click()`); const ok = await waitFor(`document.querySelector('#view-${v}')?.classList.contains('active')`); await sleep(500); return ok; };
const dialog = async (openExpr, id) => { await ev(openExpr); const ok = await waitFor(`document.getElementById('${id}').open`); await shot("dlg-" + id); await ev(`document.querySelector('#${id} [data-close]')?.click(); document.getElementById('${id}').open && document.getElementById('${id}').close()`); return ok; };
const visible = sel => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; const r=e.getBoundingClientRect(), c=getComputedStyle(e); return c.display!=='none' && c.visibility!=='hidden' && r.width>0 && r.height>0})()`);
const setFile = async (sel, path) => {
  const doc = await send("DOM.getDocument", { depth: 0 }), node = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: sel });
  await send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [path] });
};
const count = sel => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const step = async (name, fn) => { try { await fn(); } catch (e) { check(name + " (exceção no teste)", false, String(e)); } };

await send("Runtime.enable"); await send("Page.enable");
await send("Page.navigate", { url }); await sleep(1000);
await ev(`localStorage.clear(); localStorage.setItem('cf_user','Teste Smoke')`);
await send("Page.navigate", { url }); await waitFor(`document.querySelectorAll('#dash .w').length > 0`, 8000);

await step("responsive sidebar", async () => {
  await send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 700, y: 120});
  await sleep(300);
  check("sidebar starts compact", await ev(`document.querySelector('.side').getBoundingClientRect().width === 72`));
  const before = await ev(`document.querySelector('.stage').getBoundingClientRect().left`);
  await send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 30, y: 160});
  await sleep(300);
  check("hover expands sidebar", await ev(`document.querySelector('.side').getBoundingClientRect().width === 264`));
  check("hover leaves page position unchanged", before === await ev(`document.querySelector('.stage').getBoundingClientRect().left`));
  await send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 700, y: 120});
  await sleep(300);
  check("leaving sidebar collapses it", await ev(`document.querySelector('.side').getBoundingClientRect().width === 72`));
  await ev(`document.querySelector('#tabs button').focus()`);
  check("keyboard focus exposes navigation labels", await waitFor(`document.querySelector('.side').getBoundingClientRect().width === 264`));
  await ev(`document.activeElement.blur()`);
});

await step("painel", async () => {
  check("marca do site é Franchising - Team", (await ev(`document.querySelector('.brand strong').textContent`)).includes("Franchising - Team"));
  check("título da aba é Franchising - Team", (await ev("document.title")).includes("Franchising - Team"));
  check("painel tem cards", (await count("#dash .w")) >= 6);
  check("menu lateral tem as 9 seções", (await count("#tabs [data-view]")) === 9);
  check("sem faixa de servidor desatualizado", await ev(`document.querySelector('#verBanner').hidden`));
  check("alerta crítico no topo", (await count("#alerts .alertLine")) >= 1);
  check("painel mostra últimas ocorrências sem status", await ev(`document.querySelector('[data-w="urgentes"]').innerText.includes('Últimas ocorrências') && !/em andamento|Resolvida|Aberta/.test(document.querySelector('[data-w="urgentes"]').innerText)`));
  check("painel mostra descrição e botão remover nas ocorrências", await ev(`!!document.querySelector('[data-w="urgentes"] .oc .d') && !!document.querySelector('[data-w="urgentes"] [data-remove-oc]')`));
  check("contador do painel mostra publicações sem andamento", await ev(`document.querySelector('[data-w="kpi_abertas"]').innerText.includes('ocorrências publicadas') && !document.querySelector('[data-w="kpi_abertas"]').innerText.includes('em andamento')`));
  await shot("painel");
});

await step("dashboard type filters", async () => {
  await ev(`document.querySelector('[data-dpreset="none"]').click()`);
  check("clear deselects every dashboard type", await ev(`document.querySelectorAll('#dashFilter [aria-pressed="true"]').length === 0 && dashUnits().length === 0`));
  await ev(`document.querySelector('#dashFilter [data-dtipo="HB"]').click()`);
  check("one type can be selected after clearing", await ev(`document.querySelectorAll('#dashFilter [aria-pressed="true"]').length === 1 && dashTipos[0] === 'HB'`));
  await ev(`document.querySelector('#dashFilter [data-dtipo="HB"]').click()`);
  check("removing last type keeps empty selection", await ev(`Array.isArray(dashTipos) && dashTipos.length === 0 && JSON.parse(localStorage.getItem('cf_dash_tipos')).length === 0`));
  await ev(`document.querySelector('[data-dpreset="all"]').click()`);
  check("all preset selects every type", await ev(`document.querySelectorAll('#dashFilter [aria-pressed="false"]').length === 0`));
  await ev(`document.querySelector('[data-dpreset="main"]').click()`);
});

await step("heat map type filters", async () => {
  await ev(`window.heatLayout=layout;layout=[{id:'mapa',span:2}];renderDash()`);
  for (const types of [['CO'], ['CO','LJ'], [], 'all']) {
    const ok = await ev(`(()=>{setDashTipos(${JSON.stringify(types)});show('painel');const tile=document.querySelector('#dash [data-uf="SP"]');tile.click();const expected=S.units.filter(u=>u.uf==='SP'&&isLive(u)&&dashSel(u));return document.querySelector('#fUnitUf').value==='SP' && document.querySelector('#fUnitSaude').value==='viva' && document.querySelectorAll('#units article').length===Math.min(120,expected.length);})()`);
    check(`heat map carries selected types ${JSON.stringify(types)}`, ok);
    check("type selector exposes map selection", await ev(`document.querySelector('#fUnitTipo').value === ${JSON.stringify(types === 'all' ? '' : types.length === 1 ? types[0] : '__painel')}`));
    await nav('painel');
  }
  await ev(`layout=window.heatLayout;delete window.heatLayout;unitDashboardTypes=null;fillFilters();document.querySelector('#fUnitTipo').value='';document.querySelector('#fUnitUf').value='';document.querySelector('#fUnitSaude').value='';setDashTipos(null);renderUnits()`);
});

await step("dashboard packing", async () => {
  await ev(`window.savedDashLayout=layout; layout=[{id:'por_uf',span:2},{id:'por_tipo',span:1},{id:'por_categoria',span:1},{id:'saude',span:1}];renderDash()`);
  await sleep(350);
  check("short cards fill space beside tall map", await ev(`(()=>{const map=document.querySelector('[data-w="por_uf"]').getBoundingClientRect(), small=document.querySelector('[data-w="saude"]').getBoundingClientRect();return small.top < map.bottom && small.left >= map.right;})()`));
  for (const width of [390, 768, 1366]) {
    await send('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
    await sleep(350);
    check(`dashboard cards do not overlap at ${width}px`, await ev(`(()=>{const r=[...document.querySelectorAll('#dash > .w')].map(e=>e.getBoundingClientRect());return r.every((a,i)=>r.slice(i+1).every(b=>a.right<=b.left+1||b.right<=a.left+1||a.bottom<=b.top+1||b.bottom<=a.top+1)) && document.documentElement.scrollWidth<=innerWidth;})()`));
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await ev(`layout=window.savedDashLayout;delete window.savedDashLayout;renderDash()`);
  await sleep(300);
});

await step("recuperação de falhas de leitura", async () => {
  const result = await ev(`(async()=>{
    const original = window.fetch;
    let calls = 0;
    window.fetch = async (url, options) => {
      if (!String(url).endsWith('/test-retry')) return original(url, options);
      calls++;
      return new Response(JSON.stringify(calls === 1 ? {error:'Falha temporária',retryable:true} : {ok:true}), {status:calls === 1 ? 503 : 200,headers:{'Content-Type':'application/json'}});
    };
    try { const data = await api('/test-retry'); return {calls,ok:data.ok}; }
    finally { window.fetch = original; }
  })()`);
  check("leitura é repetida uma vez após falha transitória", result.calls === 2 && result.ok);
  const writes = await ev(`(async()=>{
    const original = window.fetch; let calls = 0;
    window.fetch = async (url, options) => {
      if (!String(url).endsWith('/test-retry')) return original(url, options);
      calls++;
      return new Response(JSON.stringify({error:'Falha temporária',retryable:true}), {status:503,headers:{'Content-Type':'application/json'}});
    };
    try { await api('/test-retry','POST',{}); return {calls,failed:false}; }
    catch { return {calls,failed:true}; }
    finally { window.fetch = original; }
  })()`);
  check("gravação não é repetida automaticamente", writes.calls === 1 && writes.failed);
});

await step("usuários das unidades", async () => {
  check("página de usuários abre", await nav("masters"));
  check("usuários carregam", await waitFor(`document.querySelectorAll('#mastersRows tr').length > 0`));
  check("user export offers filtered and all", await ev(`!!document.querySelector('#mastersExportFiltered') && !!document.querySelector('#mastersExportAll')`));
  check("busca de usuários mantém altura de campo", await ev(`document.querySelector('#mastersQ').getBoundingClientRect().height <= 48`));
  check("master sem segundo fator aparece sinalizado", await ev(`document.querySelector('#mastersRows').innerText.includes('Ativar segundo fator')`));
  for (const width of [390, 768]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    await sleep(200);
    check(`usuários sem rolagem horizontal em ${width}px`, await ev(`document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('#view-masters').scrollWidth <= document.querySelector('#view-masters').clientWidth`));
    check(`ações de usuários acessíveis em ${width}px`, await visible('#mastersRows [data-master-edit]'));
  }
  await send("Emulation.clearDeviceMetricsOverride");
  check("usuário vinculado tem acesso à ficha da unidade", await ev(`!!document.querySelector('#mastersRows [data-view-unit]')`));
  await ev(`document.querySelector('#mastersRows [data-view-unit]').click()`);
  check("unit link opens units tab without editing", await waitFor(`document.querySelector('#view-unidades').classList.contains('active') && !document.querySelector('#dlgUnit').open && document.querySelector('#fUnitQ').value.length > 0`));
  await ev(`document.querySelector('#fUnitQ').value='';renderUnits()`);
  await nav('masters');
  await ev(`document.querySelector('#mastersPendentes').checked=true; document.querySelector('#mastersPendentes').dispatchEvent(new Event('input',{bubbles:true}))`);
  check("filtro de pendências mostra só master sem segundo fator", await waitFor(`document.querySelectorAll('#mastersRows tr').length === 1 && document.querySelector('#mastersRows').innerText.includes('Master')`));
  await ev(`document.querySelector('#mastersRows [data-master-edit]').click()`);
  check("edição do controle abre", await waitFor(`!!document.querySelector('dialog[open] form select[name="segundo_fator"]')`));
  await ev(`document.querySelector('dialog[open] form select[name="segundo_fator"]').value='S'; document.querySelector('dialog[open] form').requestSubmit()`);
  check("regularizar segundo fator retira usuário das pendências", await waitFor(`document.querySelector('#mastersMessage').innerText.includes('Nenhum usuário')`));
  await ev(`document.querySelector('#mastersNew').click()`);
  check("formulário de novo usuário abre", await waitFor(`!!document.querySelector('#dlgMasterNew[open]')`));
  await ev(`(()=>{const f=document.querySelector('#dlgMasterNew form'); f.nome.value='Master criado no navegador'; f.matricula.value='NOVO-SMOKE'; f.ponto.value='1001'; f.requestSubmit()})()`);
  check("novo master aparece nas pendências", await waitFor(`document.querySelector('#mastersRows').innerText.includes('Master criado no navegador')`));
  await ev(`(()=>{const old=window.confirm; window.confirm=()=>true; document.querySelector('#mastersRows [data-master-delete]').click(); window.confirm=old})()`);
  check("apagar usuário atualiza a lista", await waitFor(`document.querySelector('#mastersMessage').innerText.includes('Nenhum usuário')`));
});

await step("unidades", async () => {
  check("aba unidades abre", await nav("unidades"));
  check("lista unidades (>= 6)", (await count("#units article")) >= 6);
  check("cartão mostra contagem de solicitações", await ev(`[...document.querySelectorAll('#units article')].some(a => a.innerText.includes('Solicitações:'))`));
  await ev(`(()=>{const s=document.querySelector('#fUnitSort'); s.value='solic'; s.dispatchEvent(new Event('input',{bubbles:true}))})()`); await sleep(300);
  check("ordenar por solicitações põe quem mais pede primeiro", await ev(`document.querySelector('#units article').innerText.includes('Solicitações:')`));
  await ev(`(()=>{const s=document.querySelector('#fUnitSort'); s.value='saude'; s.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await ev(`[...document.querySelectorAll('#units article')].find(a => a.innerText.includes('Solicitações:')).querySelector('[data-edit-unit]').click()`);
  check("ficha da unidade abre", await waitFor(`document.getElementById('dlgUnit').open`));
  check("ficha lista as solicitações da unidade", await waitFor(`!document.getElementById('unitSolsBox').hidden && document.querySelectorAll('#unitSols .item').length >= 1`));
  await shot("unidades-ficha");
  await ev(`document.querySelector('#dlgUnit [data-close]').click()`);
  await ev(`(()=>{const old=window.confirm;window.confirm=()=>true;document.querySelector('#units [data-inactivate-unit]').click();window.confirm=old})()`);
  check("inactivate button saves unit status", await waitFor(`S.units.some(u => u.situacao === 'inativa')`));
  check("diálogo de importação abre", await dialog(`document.querySelector('#btnImport').click()`, "dlgImport"));
  await shot("unidades");
});

await step("novas franquias", async () => {
  check("aba novas franquias abre", await nav("pipeline"));
  check("cards dos candidatos em andamento", (await count("#pipeCards .fc")) >= 2);
  await ev(`document.querySelector('#pipeCards .fc').click()`);
  check("detalhe do candidato abre", await waitFor(`document.getElementById('dlgAb').open`));
  await ev(`(()=>{const s=document.querySelector('#abPri'); s.value='alta'; s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(700);
  check("prioridade de abertura salva", await ev(`fetch('/api/state').then(r=>r.json()).then(s=>s.pipeline.aberturas.some(a=>a.prioridade==='alta'))`));
  await shot("pipeline-detalhe");
  await ev(`document.querySelector('#dlgAb [data-close]').click()`);
  await ev(`document.querySelector('#pipeMode [data-mode="grid"]').click()`); await sleep(500);
  check("visão planilha tem tabela", (await count("#pipeGrid table tbody tr")) >= 2); await shot("pipeline-planilha");
  check("planilha inicia mostrando uma fase", await ev(`document.querySelectorAll('#pipeGrid thead tr:first-child .band:not(.id)').length === 1`));
  await ev(`document.querySelector('#pipeExpand').click()`);
  check("ampliar visão usa a largura da tela", await ev(`document.querySelector('#view-pipeline').getBoundingClientRect().width >= window.innerWidth - 30`));
  await shot("pipeline-ampliada");
  await ev(`document.querySelector('#pipeExpand').click()`);
  for (const width of [390, 768, 1366]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    check(`planilha contida na página em ${width}px`, await ev(`document.documentElement.scrollWidth <= window.innerWidth && document.querySelector('#pipeGrid .gscroll').getBoundingClientRect().right <= window.innerWidth`));
  }
  await send("Emulation.clearDeviceMetricsOverride");
  await ev(`(()=>{ const td=[...document.querySelectorAll('#pipeGrid td.g-pend, #pipeGrid td.g-vazio')][0]; window.__cel = td.dataset.gab + ':' + td.dataset.gcampo; td.click(); const s=td.querySelector('select'); s.value='ok'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  check("editar célula da planilha salva como OK", await waitFor(`(()=>{ const [a,c]=window.__cel.split(':'); const td=document.querySelector('#pipeGrid td[data-gab="'+a+'"][data-gcampo="'+c+'"]'); return td && td.classList.contains('g-ok') })()`));
  await ev(`document.querySelector('#pipeMode [data-mode="req"]').click()`); await sleep(500);
  check("visão pedir dados lista candidatos", (await count("#pipeReq .rq")) >= 1); await shot("pipeline-pedidos");
  await ev(`document.querySelector('[data-rq-mark]').click()`);
  check("marcar como solicitado registra a data nos itens", await waitFor(`document.querySelectorAll('#pipeReq .chip.sol, #pipeReq .chip.cobrar').length >= 1`));
  await ev(`document.querySelector('#pipeMode [data-mode="cards"]').click()`); await sleep(300); await shot("pipeline-cards");
  check("configurar pipeline abre", await dialog(`document.querySelector('#btnPipeCfg').click()`, "dlgPipeCfg"));
  check("enviar planilha de abertura abre", await dialog(`document.querySelector('#btnAbUpload').click()`, "dlgAbUp"));
});

await step("solicitações", async () => {
  check("aba solicitações abre", await nav("solicitacoes"));
  check("kanban com etapas", (await count("#solBoard .scol")) >= 5);
  const antes = await count("#solBoard .sc");
  check("cartões abertos", antes >= 2); await shot("solicitacoes-kanban");
  const dnd = await ev(`(async()=>{ const card=document.querySelector('#solBoard .sc'), titulo=card.querySelector('.sctitle').textContent, from=card.closest('.scol');
    const to=[...document.querySelectorAll('#solBoard .scol')].find(c=>c!==from); const dt=new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt})); to.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt})); to.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
    await new Promise(r=>setTimeout(r,1200)); const now=[...document.querySelectorAll('#solBoard .sc')].find(c=>c.querySelector('.sctitle').textContent===titulo).closest('.scol');
    return now.dataset.etapa===to.dataset.etapa })()`);
  check("arrastar cartão muda a etapa", dnd);
  await ev(`document.querySelector('#solBoard .sc').click()`);
  check("solicitação aberta mostra Finalizar e Excluir, sem Reabrir", (await waitFor(`document.getElementById('dlgSol').open`)) && (await visible("#btnSolFin")) && (await visible("#btnSolDel")) && !(await visible("#btnSolReopen")));
  await ev(`document.querySelector('#dlgSol [data-close]').click()`);
  await ev(`document.querySelector('#btnSolNew').click()`);
  check("nova solicitação abre", await waitFor(`document.getElementById('dlgSol').open`));
  check("nova solicitação não mostra Excluir, Finalizar, Reabrir nem Abrir no Jira", !(await visible("#btnSolDel")) && !(await visible("#btnSolFin")) && !(await visible("#btnSolReopen")) && !(await visible("#sOpen")));
  await ev(`(()=>{document.querySelector('#sTitulo').value='Chamado criado pelo smoke'; const j=document.querySelector('#sJira'); j.value='https://empresa.atlassian.net/browse/MRH-12086'; j.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  check("URL colada vira link e chave", await ev(`document.querySelector('#sLink').value.includes('MRH-12086') && document.querySelector('#sJira').value === 'MRH-12086'`));
  await shot("solicitacoes-form");
  await ev(`document.querySelector('#formSol button[type=submit]').click()`);
  check("solicitação criada aparece no kanban", await waitFor(`document.querySelectorAll('#solBoard .sc').length === ${antes + 1}`));
  check("chave MRH-12086 é hiperlink", await ev(`[...document.querySelectorAll('#solBoard a.jira')].some(a => a.textContent.includes('MRH-12086') && a.href.includes('MRH-12086'))`));
  await ev(`[...document.querySelectorAll('#solBoard .sc')].find(c => c.innerText.includes('Chamado criado pelo smoke')).querySelector('[data-solfin]').click()`);
  check("finalizar tira do kanban", await waitFor(`document.querySelectorAll('#solBoard .sc').length === ${antes}`));
  await ev(`document.querySelector('#solMode [data-smode="lista"]').click()`);
  check("lista de finalizadas mostra os dias", await waitFor(`document.querySelectorAll('#solList tbody tr').length >= 2`)); await shot("solicitacoes-lista");
  await ev(`document.querySelector('[data-view="pipeline"]').click()`);
  await waitFor(`document.querySelector('#pipeList [data-ab], .fc[data-ab]')`);
  await ev(`document.querySelector('.fc[data-ab]').click()`); await waitFor(`document.getElementById('dlgAb').open`);
  await ev(`document.querySelector('#btnAbToUnit').click()`); await waitFor(`document.getElementById('dlgUnit').open`);
  check("enviar candidato às ativas abre o formulário de unidade já preenchido", await waitFor(`document.querySelector('#formUnit [name=nome]').value.length > 0 && !document.querySelector('#formUnit').dataset.id && document.querySelector('#formUnit').dataset.ab && document.querySelector('#formUnit [name=desde]').value`));
  await ev(`document.querySelector('#formUnit [name=razao_social]').click()`);
  check("unit fields do not reopen candidate dialog", await ev(`document.querySelector('#dlgUnit').open && !document.querySelector('#dlgAb').open`));
  await ev(`document.querySelector('#formUnit [name=razao_social]').value='Empresa Smoke'; document.querySelector('#formUnit button[type=submit]').click()`);
  check("sent candidate leaves new franchises", await waitFor(`!document.getElementById('dlgUnit').open && ![...document.querySelectorAll('.fc .badge')].some(b => b.textContent.includes('Nas unidades ativas'))`));
  await ev(`document.querySelector('#fPipeSit').value='enviada'; document.querySelector('#fPipeSit').dispatchEvent(new Event('input',{bubbles:true}))`);
  check("sent candidate history remains available", await waitFor(`[...document.querySelectorAll('.fc .badge')].some(b => b.textContent.includes('Nas unidades ativas'))`));
  const iso = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  await ev(`document.querySelector('#btnSolNew').click()`); await waitFor(`document.getElementById('dlgSol').open`);
  await ev(`(()=>{document.querySelector('#sTitulo').value='Chamado antigo do smoke'; document.querySelector('#sCriado').value='${iso(20)}'; document.querySelector('#sFinal').value='${iso(13)}'; document.querySelector('#formSol button[type=submit]').click()})()`);
  check("chamado antigo (datas de abertura e finalização) entra na lista com 7 dias", await waitFor(`[...document.querySelectorAll('#solList tbody tr')].some(r => r.innerText.includes('Chamado antigo do smoke') && r.children[8].textContent.trim() === '7')`));
  await ev(`document.querySelector('#solMode [data-smode="ranking"]').click()`);
  check("ranking por unidade", await waitFor(`document.querySelectorAll('#solRank tbody tr').length >= 1`)); await shot("solicitacoes-ranking");
  check("ranking has summary cards and charts", await waitFor(`document.querySelectorAll('.sol-rank-stats .sum').length === 4 && document.querySelectorAll('.sol-rank-charts .w').length === 2`));
  await ev(`document.querySelector('.sol-rank-detail').open=true`);
  check("expanding unit loads requests", await waitFor(`document.querySelectorAll('.sol-rank-items [data-sol]').length > 0`));
  check("ranking expansion does not edit unit", await ev(`!document.querySelector('#dlgUnit').open`));
  await ev(`document.querySelector('#solMode [data-smode="lista"]').click()`);
  await nav("solicitacoes");
  check("finalized export action is visible", await visible('#btnSolExport'));
  await ev(`document.querySelector('#solMode [data-smode="ranking"]').click()`);

  await ev(`document.querySelector('#solMode [data-smode="kanban"]').click()`);
  check("configurar solicitações abre", await dialog(`document.querySelector('#btnSolCfg').click()`, "dlgSolCfg"));
});

await step("ocorrências e demais abas", async () => {
  check("aba ocorrências abre", await nav("ocorrencias"));
  check("lista a ocorrência crítica", (await count("#incidents article")) >= 1); await shot("ocorrencias");
  check("nova ocorrência abre", await dialog(`document.querySelector('#btnNewOc').click()`, "dlgOc"));
  check("aba aberturas por ano tem tabela", (await nav("aberturas")) && (await count("#abContent table")) >= 1);
  check("aberturas tem filtros de tipo em botões", (await count('#abTypeFilter [data-abtipo]')) >= 3);
  check("comparativo tem um ano por linha", await ev(`/^20\\d{2}$/.test(document.querySelector('.annual-table tbody tr th').innerText)`));
  await ev(`document.querySelector('#abTypeFilter [data-abpreset="all"]').click()`);
  check("selecionar todos os tipos atualiza os botões", await ev(`[...document.querySelectorAll('#abTypeFilter [data-abtipo]')].every(b => b.getAttribute('aria-pressed') === 'true')`));
  await shot("aberturas");
  for (const width of [390, 768, 1366]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    check(`aberturas sem rolagem horizontal da página em ${width}px`, await ev(`document.documentElement.scrollWidth <= window.innerWidth`));
    if (width === 390) await shot("aberturas-celular");
  }
  await send("Emulation.clearDeviceMetricsOverride");
  check("aba atualizações lista os envios", (await nav("atualizacoes")) && (await count("#snapList article")) >= 1); await shot("atualizacoes");
  check("enviar planilha de unidades abre", await dialog(`document.querySelector('#btnUpload').click()`, "dlgUpload"));
  check("aba atividade lista o histórico", (await nav("atividade")) && (await count("#logList .logrow")) >= 1); await shot("atividade");
});

await step("importação com comparação", async () => {
  await nav("atualizacoes");
  await ev(`document.querySelector('#btnUpload').click()`); await waitFor(`document.getElementById('dlgUpload').open`);
  await setFile("#upFile", unitsXlsx); await ev(`document.querySelector('#formUpload').requestSubmit()`);
  check("análise da planilha de unidades mostra o resumo", await waitFor(`document.querySelectorAll('#upResult .sumgrid .sum').length >= 4`));
  check("aviso de unidades sem UF aparece", await ev(`document.querySelector('#upResult').innerText.includes('SEM UF')`));
  check("mesma planilha: sem diferenças", await ev(`document.querySelector('#upResult').innerText.includes('Nenhuma diferença')`)); await shot("upload-unidades");
  await ev(`document.querySelector('#dlgUpload [data-close]').click()`);
  await nav("pipeline");
  await ev(`document.querySelector('#btnAbUpload').click()`); await waitFor(`document.getElementById('dlgAbUp').open`);
  await setFile("#abUpFile", aberturaXlsx); await ev(`document.querySelector('#formAbUp').requestSubmit()`);
  check("análise da planilha de abertura mostra o resumo", await waitFor(`document.querySelectorAll('#abUpResult .sumgrid .sum').length >= 4`));
  check("abertura: lista informa que não há diferença", await ev(`document.querySelector('#abUpResult').innerText.includes('Nenhuma diferença')`)); await shot("upload-abertura");
  await ev(`document.querySelector('#dlgAbUp [data-close]').click()`);
});

await step("tema escuro", async () => {
  await nav("painel");
  const antes = await ev(`document.documentElement.dataset.theme || 'light'`);
  await ev(`document.querySelector('#btnTheme').click()`);
  check("alternar tema", (await ev(`document.documentElement.dataset.theme`)) !== antes); await shot("painel-escuro");
  // contraste WCAG calculado no Node a partir das cores reais renderizadas (rgb/rgba)
  const lum = rgb => { const [r, g, b] = rgb.map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
  const contraste = async sel => {
    const cores = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const c=getComputedStyle(e); return [c.color, c.backgroundColor]})()`);
    if (!cores) return { ratio: 0, cores };
    const [fg, bg] = cores.map(c => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number));
    if (fg.length < 3 || bg.length < 3) return { ratio: 0, cores };
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return { ratio: (hi + .05) / (lo + .05), cores };
  };
  check("tema escuro: faixa de alerta crítico tem contraste >= 4.5", (await contraste("#alerts")).ratio >= 4.5, JSON.stringify(await contraste("#alerts")));
  check("tema escuro: contador de ocorrências tem contraste >= 4.5", (await contraste("#badgeOc")).ratio >= 4.5, JSON.stringify(await contraste("#badgeOc")));
  await ev(`document.querySelector('#btnTheme').click()`);
});

check("nenhum erro de JavaScript", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} verificações ok`);
ws.close(); proc.kill();
process.exit(failed ? 1 : 0);
