$("#mastersImport").onclick = () => $("#mastersFile").click();
let mastersPage = 1, mastersData = [], mastersRequest = 0, mastersTimer;
async function loadMasters() {
  const requestId = ++mastersRequest;
  const params = new URLSearchParams({ page: mastersPage, q: $("#mastersQ").value,
    perfil: $("#mastersPerfil").value, enabled: $("#mastersEnabled").value,
    segundo_fator: $("#mastersSegundo").value, vinculo: $("#mastersVinculo").value,
    pendentes: $("#mastersPendentes").checked ? "1" : "" });
  $("#mastersMessage").textContent = "Carregando usuários…";
  try {
    const data = await api("/masters?" + params);
    if (requestId !== mastersRequest) return;
    mastersPage = data.page; mastersData = data.items;
    const s = data.summary;
    $("#mastersSummary").innerHTML = [[s.total,"Usuários"],[s.masters,"Masters"],
      [s.masters_pendentes,"Masters sem segundo fator"],[s.inativos,"Usuários inativos"]]
      .map(([n,t], index) => `<div class="sum ${index === 2 ? "masters-stat-alert" : ""}"><span>${t}</span><b>${n.toLocaleString("pt-BR")}</b></div>`).join("");
    $("#mastersRows").innerHTML = data.items.map(i => `<tr>
      <td data-label="Usuário / matrícula"><strong>${esc(i.nome)}</strong><div class="muted">${esc(i.matricula)}</div></td>
      <td data-label="Perfil"><span class="masters-profile">${esc(i.perfil)}</span></td><td data-label="Ponto / unidade ativa">${esc(i.ponto)}<div>${i.unidades.length ? i.unidades.map(u => `<button class="btn sm ghost" data-edit-unit="${u.id}">${esc(u.nome)} · ${esc(u.uf)}</button>`).join("") : '<span class="muted">Sem unidade ativa</span>'}</div>${i.vinculo === "ambiguo" ? '<span class="badge b-alta">Conferir vínculo: ponto repetido</span>' : ""}</td>
      <td data-label="Usuário"><span class="badge ${i.enabled ? "b-ok" : "b-alta"}">${i.enabled ? "Ativo" : "Inativo"}</span></td>
      <td data-label="Segundo fator"><span class="badge ${i.segundo_fator === "S" ? "b-ok" : "b-none"}">${i.segundo_fator === "S" ? "Ativo" : "Inativo"}</span></td>
      <td data-label="Pendência">${i.pendencia_master ? '<span class="badge b-critica">Ativar segundo fator</span>' : "—"}</td>
      <td data-label="Ações" class="masters-actions"><button class="btn sm" data-master-edit="${i.id}">Atualizar controle</button>
      <button class="btn sm danger ghost" data-master-delete="${i.id}">Apagar</button></td></tr>`).join("");
    $("#mastersMessage").textContent = data.total ? `${data.total} usuário(s) encontrado(s).` : "Nenhum usuário encontrado. Importe a planilha ou ajuste os filtros.";
    $("#mastersPage").textContent = `Página ${data.page} de ${data.pages}`;
    $("#mastersPrev").disabled = data.page <= 1; $("#mastersNext").disabled = data.page >= data.pages;
  } catch (err) { if (requestId === mastersRequest) $("#mastersMessage").textContent = err.message; }
}
$("#mastersFilters").addEventListener("input", () => {
  clearTimeout(mastersTimer); mastersRequest++; mastersPage = 1;
  mastersTimer = setTimeout(loadMasters, 250);
});
$("#mastersPrev").onclick = () => { mastersPage--; loadMasters(); };
$("#mastersNext").onclick = () => { mastersPage++; loadMasters(); };
$("#mastersFile").onchange = async e => {
  if (!e.target.files[0]) return;
  const data = new FormData(); data.append("file", e.target.files[0]);
  $("#mastersMessage").textContent = "Importando usuários…";
  e.target.disabled = true;
  try {
    const result = await api("/masters/import", "POST", data);
    mastersPage = 1; await loadMasters();
    toast(`${result.total} usuários atualizados. Registros ausentes foram preservados.`);
  } catch (err) { $("#mastersMessage").textContent = err.message; }
  finally { e.target.value = ""; e.target.disabled = false; }
};
$("#mastersRows").addEventListener("click", async e => {
  const remove = e.target.closest("[data-master-delete]");
  if (remove) {
    const item = mastersData.find(i => i.id == remove.dataset.masterDelete);
    if (!confirm(`Apagar ${item.nome} (matrícula ${item.matricula}, ponto ${item.ponto}) do controle local?`)) return;
    remove.disabled = true;
    try { await api("/masters/" + item.id, "DELETE"); await loadMasters(); toast("Usuário apagado do controle."); }
    catch (err) { toast(esc(err.message)); remove.disabled = false; }
    return;
  }
  const button = e.target.closest("[data-master-edit]"); if (!button) return;
  const item = mastersData.find(i => i.id == button.dataset.masterEdit);
  const dialog = document.createElement("dialog");
  dialog.className = "masters-dialog";
  dialog.innerHTML = `<form><h3>Atualizar controle do usuário</h3>
    <p class="muted">Matrícula ${esc(item.matricula)} · ponto ${esc(item.ponto)}. Registre aqui a situação confirmada no sistema de origem.</p>
    <label>Nome<input name="nome" required maxlength="200" value="${esc(item.nome)}"></label>
    <label>Usuário<select name="enabled"><option value="1">Ativo</option><option value="0">Inativo</option></select></label>
    <label>Segundo fator<select name="segundo_fator"><option value="S">Ativo</option><option value="N">Inativo</option></select></label>
    <p class="formErr" role="alert"></p><div class="foot"><button type="button" class="btn ghost">Cancelar</button><button type="submit" class="btn primary">Salvar</button></div></form>`;
  document.body.appendChild(dialog);
  const form = dialog.querySelector("form"); form.enabled.value = item.enabled; form.segundo_fator.value = item.segundo_fator;
  dialog.querySelector('[type="button"]').onclick = () => dialog.close();
  dialog.onclose = () => dialog.remove();
  form.onsubmit = async event => {
    event.preventDefault(); const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
    try { await api("/masters/" + item.id, "PUT", Object.fromEntries(new FormData(form))); dialog.close(); await loadMasters(); }
    catch (err) { dialog.querySelector(".formErr").textContent = err.message; }
    finally { submit.disabled = false; }
  };
  dialog.showModal();
});

$("#mastersNew").onclick = () => {
  const dialog = document.createElement("dialog");
  dialog.className = "masters-dialog";
  dialog.id = "dlgMasterNew";
  dialog.innerHTML = `<form><h3>Novo usuário</h3>
    <p class="muted">Cadastre o usuário no controle local. O ponto faz a ligação com a unidade ativa.</p>
    <label>Nome<input name="nome" required maxlength="200"></label>
    <label>Matrícula<input name="matricula" required maxlength="100"></label>
    <label>Número do ponto<input name="ponto" required maxlength="50" inputmode="numeric" list="masterPoints"></label>
    <datalist id="masterPoints">${S.units.filter(isLive).filter(u => u.ponto).map(u => `<option value="${esc(u.ponto)}">${esc(u.nome)}</option>`).join("")}</datalist>
    <label>Perfil<select name="fator_autenticacao"><option value="2">Master</option><option value="1">Operacional</option><option value="3">Código 3</option><option value="4">Código 4</option></select></label>
    <label>Usuário<select name="enabled"><option value="1">Ativo</option><option value="0">Inativo</option></select></label>
    <label>Segundo fator<select name="segundo_fator"><option value="N">Inativo</option><option value="S">Ativo</option></select></label>
    <p class="muted">Masters sem segundo fator ativo serão sinalizados como pendentes.</p>
    <p class="formErr" role="alert"></p><div class="foot"><button type="button" class="btn ghost">Cancelar</button><button type="submit" class="btn primary">Criar usuário</button></div></form>`;
  document.body.appendChild(dialog);
  dialog.querySelector('[type="button"]').onclick = () => dialog.close();
  dialog.onclose = () => dialog.remove();
  dialog.querySelector("form").onsubmit = async e => {
    e.preventDefault(); const submit = e.target.querySelector('[type="submit"]'); submit.disabled = true;
    try {
      await api("/masters", "POST", Object.fromEntries(new FormData(e.target)));
      dialog.close(); mastersPage = 1; await loadMasters(); toast("Usuário criado no controle.");
    } catch (err) { dialog.querySelector(".formErr").textContent = err.message; }
    finally { submit.disabled = false; }
  };
  dialog.showModal();
};
