"""Planilhas de exemplo (geradas em memória) e carga inicial usadas pelos testes. Não depende dos arquivos reais."""
import datetime as dt
from io import BytesIO

from openpyxl import Workbook


def _xlsx(wb):
    bio = BytesIO()
    wb.save(bio)
    bio.seek(0)
    return bio


def units_workbook():
    """CO / HB / JE com os casos difíceis: sigla+ponto repetidos (CNPJ diferente), coluna sem cabeçalho, UF vazia, master do JE."""
    wb = Workbook()
    co = wb.active
    co.title = "CO - Centro Operacional"
    co.append(["uf", "NICKNAME", "Consultor de Campo", "SIGLA", "PONTO", "CNPJ", "RAZÃO SOCIAL", "CIDADE", "FRANQUEADO", "CFTV", "DESDE"])
    co.append(["SP", "CO TESTE 01", "ana.silva", "CO-TST-01", 1001, "11.222.333/0001-81", "RAZAO UM", "SAO PAULO", "Sr. Fulano", "SIM", dt.datetime(2021, 3, 15)])
    co.append(["RJ", "CO TESTE 02", "bruno.lima", "CO-TST-02", 1002, "22.333.444/0001-55", "RAZAO DOIS", "RIO", "Sra. Beltrana", "N", dt.datetime(2025, 10, 2)])
    hb = wb.create_sheet("HB - Hubs")
    hb.append(["UF", "NICKNAME", "SIGLA", "PONTO", "CNPJ", "RAZÃO SOCIAL", "CIDADE", "PARCEIRO OPERACIONAL"])
    hb.append(["MG", "HB DUP 01", "HB-DUP-01", 2001, "05.882.643/0003-91", "MADRI", "BH", "Sr. A"])
    hb.append(["MG", "HB DUP 01", "HB-DUP-01", 2001, "05.882.643/0005-53", "MADRI", "BH", "NILTON"])
    je = wb.create_sheet("JE - FRANQUIA LIGHT")
    je.append(["uf", "NICKNAME", "SIGLA", "ponto", "CNPJ", "RAZÃO SOCIAL", "CIDADE", "FRANQUEADO", None, "FRANQUIA MASTER"])
    je.append(["SP", "JE TESTE 01", "JE-TST-01", 3001, "33.444.555/0001-99", "RAZAO JE", "JOANOPOLIS", "Otavio", "sem_titulo@x.com", "CO TESTE 01"])
    je.append(["", "JE SEM UF", "JE-SUF-01", 3002, "", "RAZAO SEM UF", "NOWHERE", "Ninguem", None, ""])
    return _xlsx(wb)


def abertura_workbook(direx="-"):
    """Aba start_26: linha 1 = fases, linha 2 = tipos, linha 3 = campos, 4+ = candidatos."""
    wb = Workbook()
    ws = wb.active
    ws.title = "start_26"
    ws["E1"], ws["H1"] = "F A S E  I N I C I A L   1", "FASE FINAL 2"
    ws["F2"] = "DOCUMENTAÇÃO"
    ws.merge_cells("F2:G2")
    ws.append(["uf", "LOCALIDADE/UNIDADE (master)", "Start process", "candidato", "apres.", "CNPJ", "contrato social", "pedido ativação FIN", "e-mail oficial"])
    ws.append(["SP", "FRANQUIA ALFA 01", "26.09.01", "Joao Silva", direx, "ok", "-", "2026-10-01", "alfa@x.com"])
    ws.append(["RJ", "FRANQUIA BETA 02", "26.10.15", "Maria Souza", "-", "-", "-", "-", ""])
    ws.append(["MG", "FRANQUIA GAMA 03", "26.05.01", "Pedro Lima", "ok", "ok", "ok", "ok", "gama@x.com"])
    return _xlsx(wb)


def upload(client, path, xlsx, **form):
    return client.post(path, data=dict(file=(xlsx, "planilha.xlsx"), **form), content_type="multipart/form-data")


def seed(client):
    """Carga mínima para o smoke de navegador: unidades, candidatos, uma ocorrência e solicitações ligadas a unidades."""
    for pv, cm, xlsx, extra in (("/api/import/preview", "/api/import/commit", units_workbook(), {"ref_month": "2026-11"}),
                                ("/api/pipeline/preview", "/api/pipeline/commit", abertura_workbook(), {"sheet": "start_26"})):
        r = upload(client, pv, xlsx, **extra).get_json()
        client.post(cm, json={"token": r["token"], "ref_month": "2026-11", "filename": "x.xlsx", "sheet": "start_26"})
    st = client.get("/api/state").get_json()
    units = [u for u in st["units"] if u["sigla"]]
    users = f"OPER_MATRIC;OPER_NOME;PONTO_CODI;ENABLED;SEGUNDO_FATOR;FATOR_AUTENTICACAO\nM1;Master teste;{units[0]['ponto']};1;N;2\nO1;Operacional teste;999999;0;N;1\n".encode()
    client.post("/api/masters/import", data={"file": (BytesIO(users), "users.csv")})
    client.post("/api/incidents", json={"unit_id": units[0]["id"], "titulo": "Incêndio na unidade", "severidade": "critica", "descricao": "Operação temporariamente interrompida."})
    cats = {c["nome"]: c["id"] for c in st["sol"]["categorias"]}
    subs = {s["nome"]: s["id"] for s in st["sol"]["subcategorias"]}
    etapas = {e["nome"]: e["id"] for e in st["sol"]["etapas"]}
    ids = []
    for i, (t, cat, sub, pri) in enumerate([("Reset de senha do portal", "Jira", "Reset de senha", "alta"),
                                            ("Troca de CNPJ", "Unidade", "Troca de CNPJ", "media"),
                                            ("Cadastro no Salesforce", "Jira", "Salesforce", "urgente")]):
        ids.append(client.post("/api/sol", json={"titulo": t, "categoria_id": cats[cat], "subcategoria_id": subs[sub], "prioridade": pri,
                                                 "unidade_id": units[i % len(units)]["id"], "solicitante": "Teste", "responsavel": "Raul",
                                                 "jira": f"MRH-{12000 + i}"}).get_json()["id"])
    client.put(f"/api/sol/{ids[0]}/etapa", json={"etapa_id": etapas["Em análise"]})
    client.put(f"/api/sol/{ids[2]}/etapa", json={"etapa_id": etapas["Finalizada"]})
    return st
