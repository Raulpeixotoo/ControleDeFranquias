"""Testes de regressão do backend. Rodar:  python -m unittest discover -s tests -v
Cada execução usa um banco temporário; os testes são numerados porque compartilham o mesmo banco (fluxo de ponta a ponta)."""
import datetime as dt
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
_tmp = tempfile.mkdtemp()
os.environ["FRANQUIAS_DB"] = os.path.join(_tmp, "test.db")

import app  # noqa: E402
import fixtures  # noqa: E402


class Fluxo(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = app.app.test_client()

    def state(self):
        return self.c.get("/api/state").get_json()

    def test_01_ping_e_estado(self):
        p = self.c.get("/api/ping").get_json()
        self.assertGreaterEqual(p["version"], 8)
        st = self.state()
        for k in ("units", "incidents", "log", "snapshots", "pipeline", "sol", "sol_units", "ufs"):
            self.assertIn(k, st)
        self.assertEqual(len(st["sol"]["etapas"]), 7)            # dados iniciais das solicitações
        self.assertIn("Jira", [c["nome"] for c in st["sol"]["categorias"]])

    def test_02_importar_unidades_traz_tudo(self):
        r = fixtures.upload(self.c, "/api/import/preview", fixtures.units_workbook(), ref_month="2026-11").get_json()
        self.assertEqual((r["total"], r["novas"], r["primeira"]), (6, 6, True))
        self.assertTrue(any("SEM UF" in w for w in r["warnings"]))
        ok = self.c.post("/api/import/commit", json={"token": r["token"], "ref_month": "2026-11", "filename": "u.xlsx"}).get_json()
        self.assertTrue(ok["ok"])
        us = {u["nome"] + "|" + (u["cnpj"] or ""): u for u in self.state()["units"]}
        self.assertEqual(len([u for u in us.values() if u["sigla"] == "HB-DUP-01"]), 2)      # mesma sigla+ponto, CNPJs diferentes: as duas entram
        hb = [u for u in us.values() if u["sigla"] == "HB-DUP-01" and "0005" in u["cnpj"]][0]
        self.assertEqual(hb["responsavel"], "NILTON")                                           # parceiro operacional = responsável
        je = next(u for u in us.values() if u["sigla"] == "JE-TST-01")
        self.assertEqual(je["unidade_master"], "CO TESTE 01")
        self.assertEqual(next(u for u in us.values() if u["nome"] == "JE SEM UF")["uf"], "")    # UF vazia não descarta a unidade
        d = self.c.get(f"/api/units/{je['id']}").get_json()
        self.assertTrue(any("sem título" in k for k in d["extra"]))                             # coluna sem cabeçalho preservada
        self.assertEqual(d["solicitacoes"], [])

    def test_03_atualizacao_mensal_compara(self):
        r = fixtures.upload(self.c, "/api/import/preview", fixtures.units_workbook(), ref_month="2026-12").get_json()
        self.assertEqual((r["novas"], r["saidas"], r["alteradas"], r["sem_mudanca"]), (0, 0, 0, 6))

    def test_04_importacao_em_lote_sem_limite_de_2000(self):
        rows = [{"nome": f"Lote {i}", "uf": "SP"} for i in range(2500)]
        r = self.c.post("/api/units/bulk", json={"rows": rows}).get_json()
        self.assertEqual(r["importadas"], 2500)

    def test_05_ocorrencia_e_log(self):
        uid = next(u["id"] for u in self.state()["units"] if u["sigla"] == "CO-TST-01")
        r = self.c.post("/api/incidents", json={"unit_id": uid, "titulo": "Incêndio", "severidade": "critica"})
        self.assertEqual(r.status_code, 201)
        st = self.state()
        self.assertTrue(any(i["severidade"] == "critica" and i["status"] == "aberta" for i in st["incidents"]))
        self.assertNotEqual(self.c.get("/api/rev").get_json()["rev"], "")

    def test_06_pipeline_importa_e_preserva_edicao_do_site(self):
        r = fixtures.upload(self.c, "/api/pipeline/preview", fixtures.abertura_workbook(), sheet="start_26").get_json()
        self.assertEqual((r["total"], r["novas"]), (3, 3))
        self.assertEqual(r["fases"], ["Fase Inicial 1", "Fase Final 2"])
        self.c.post("/api/pipeline/commit", json={"token": r["token"], "sheet": "start_26"})
        pl = self.state()["pipeline"]
        tipos = {t["id"]: t["nome"] for t in pl["tipos"]}
        cnpj = next(c for c in pl["campos"] if c["label"] == "CNPJ")
        self.assertEqual(tipos[cnpj["tipo_id"]], "Documentação")
        self.assertEqual(cnpj["pedir"], 1)                                                      # documentação entra em "pedir ao franqueado"
        self.assertEqual(next(c for c in pl["campos"] if c["label"] == "pedido ativação FIN")["kind"], "data")
        alfa = next(a for a in pl["aberturas"] if a["nome"] == "FRANQUIA ALFA 01")
        contrato = next(c for c in pl["campos"] if c["label"] == "contrato social")
        # edição feita no site...
        self.assertTrue(self.c.put(f"/api/aberturas/{alfa['id']}/valor", json={"campo_id": contrato["id"], "valor": "ok"}).get_json()["changed"])
        # ...sobrevive a uma planilha nova que muda OUTRA célula
        r2 = fixtures.upload(self.c, "/api/pipeline/preview", fixtures.abertura_workbook(direx="ok"), sheet="start_26").get_json()
        self.assertEqual((r2["novas"], r2["com_mudanca"], r2["valores_mudados"]), (0, 1, 1))
        self.c.post("/api/pipeline/commit", json={"token": r2["token"], "sheet": "start_26"})
        alfa = next(a for a in self.state()["pipeline"]["aberturas"] if a["id"] == alfa["id"])
        self.assertEqual(alfa["v"][str(contrato["id"])], "ok")

    def test_07_prioridade_da_abertura(self):
        ab = self.state()["pipeline"]["aberturas"][0]
        self.assertTrue(self.c.put(f"/api/aberturas/{ab['id']}/prioridade", json={"prioridade": "urgente"}).get_json()["ok"])
        self.assertEqual(self.c.put(f"/api/aberturas/{ab['id']}/prioridade", json={"prioridade": "xx"}).status_code, 400)
        self.assertEqual(next(a for a in self.state()["pipeline"]["aberturas"] if a["id"] == ab["id"])["prioridade"], "urgente")

    def test_08_solicitacoes_link_jira_e_contagem_por_unidade(self):
        st = self.state()
        cats = {c["nome"]: c["id"] for c in st["sol"]["categorias"]}
        subs = {s["nome"]: s["id"] for s in st["sol"]["subcategorias"]}
        etapas = {e["nome"]: e["id"] for e in st["sol"]["etapas"]}
        uid = next(u["id"] for u in st["units"] if u["sigla"] == "CO-TST-01")
        # cola a URL no campo da chave: a chave é extraída e o endereço base do Jira é aprendido
        r = self.c.post("/api/sol", json={"titulo": "Reset de senha", "categoria_id": cats["Jira"], "subcategoria_id": subs["Reset de senha"],
                                          "unidade_id": uid, "jira": "https://empresa.atlassian.net/browse/MRH-12086"})
        self.assertEqual(r.status_code, 201)
        sid = r.get_json()["id"]
        item = next(i for i in self.state()["sol"]["abertas"] if i["id"] == sid)
        self.assertEqual((item["jira"], item["link"]), ("MRH-12086", "https://empresa.atlassian.net/browse/MRH-12086"))
        self.assertEqual(self.state()["sol"]["jira_base"], "https://empresa.atlassian.net/browse/")
        # segunda solicitação na mesma unidade; finaliza a primeira
        self.c.post("/api/sol", json={"titulo": "Troca de CNPJ", "categoria_id": cats["Unidade"], "unidade_id": uid, "jira": "MRH-1"})
        self.c.put(f"/api/sol/{sid}/etapa", json={"etapa_id": etapas["Em análise"]})
        self.c.post(f"/api/sol/{sid}/nota", json={"texto": "aguardando TI"})
        self.c.put(f"/api/sol/{sid}/etapa", json={"etapa_id": etapas["Finalizada"]})
        fin = self.c.get("/api/sol/finalizadas?dias=90").get_json()["items"]
        self.assertEqual([i["id"] for i in fin], [sid])
        self.assertEqual([h["evento"] for h in self.c.get(f"/api/sol/{sid}").get_json()["hist"]], ["finalizada", "nota", "etapa", "aberta"])
        # contagem por unidade e ranking
        su = self.state()["sol_units"][str(uid)]
        self.assertEqual((su["tot"], su["d90"], su["ab"]), (2, 2, 1))
        rk = self.c.get("/api/sol/ranking?dias=90").get_json()
        top = rk["rows"][0]
        self.assertEqual((top["id"], top["tot"], top["ab"]), (uid, 2, 1))
        self.assertIsNotNone(top["media_dias"])
        self.assertEqual(self.c.get(f"/api/sol/ranking?dias=90&cat={cats['Outros']}").get_json()["rows"], [])
        detail = self.c.get(f"/api/units/{uid}").get_json()
        self.assertEqual(len(detail["solicitacoes"]), 2)

    def test_09_configuracao_protege_itens_em_uso(self):
        et = next(e for e in self.state()["sol"]["etapas"] if e["nome"] == "Finalizada")
        self.assertEqual(self.c.delete(f"/api/solcfg/etapas/{et['id']}").status_code, 409)
        nova = self.c.post("/api/solcfg/etapas", json={"nome": "Teste", "final": 0}).get_json()["id"]
        self.assertTrue(self.c.delete(f"/api/solcfg/etapas/{nova}").get_json()["ok"])
        self.assertEqual(self.c.put("/api/settings", json={"jira_base": "ftp://x"}).status_code, 400)

    def test_10_unidade_sem_titulo_valida_entrada(self):
        self.assertEqual(self.c.post("/api/sol", json={"titulo": "", "categoria_id": 1}).status_code, 400)
        self.assertEqual(self.c.post("/api/units", json={"nome": "X", "uf": "ZZ"}).status_code, 400)

    def test_11_registrar_chamado_antigo_com_datas(self):
        st = self.state()
        cat = next(c["id"] for c in st["sol"]["categorias"] if c["nome"] == "Jira")
        uid = next(u["id"] for u in st["units"] if u["sigla"] == "CO-TST-01")
        day = lambda n: (dt.date.today() - dt.timedelta(days=n)).isoformat()
        base = {"titulo": "Chamado antigo", "categoria_id": cat, "unidade_id": uid}
        # já nasce encerrado, com as datas informadas
        sid = self.c.post("/api/sol", json={**base, "criado_em": day(40), "finalizado_em": day(31)}).get_json()["id"]
        fin = {i["id"]: i for i in self.c.get("/api/sol/finalizadas?dias=0").get_json()["items"]}[sid]
        self.assertEqual((fin["criado_em"][:10], fin["finalizado_em"][:10], fin["etapa_nome"]), (day(40), day(31), "Finalizada"))
        self.assertNotIn(sid, [i["id"] for i in self.state()["sol"]["abertas"]])
        # corrigir a data de finalização de chamado já encerrado
        self.assertTrue(self.c.put(f"/api/sol/{sid}", json={**base, "finalizado_em": day(35)}).get_json()["ok"])
        self.assertEqual(self.c.get(f"/api/sol/{sid}").get_json()["item"]["finalizado_em"][:10], day(35))
        # chamado antigo ainda aberto: os dias abertos contam desde a data informada
        aberto = self.c.post("/api/sol", json={**base, "titulo": "Antigo aberto", "criado_em": day(25)}).get_json()["id"]
        item = next(i for i in self.state()["sol"]["abertas"] if i["id"] == aberto)
        self.assertEqual((item["criado_em"][:10], item["atualizado_em"][:10]), (day(25), day(25)))
        # finalizar com data informada pela mudança de etapa
        etapa = next(e["id"] for e in self.state()["sol"]["etapas"] if e["nome"] == "Finalizada")
        self.assertEqual(self.c.put(f"/api/sol/{aberto}/etapa", json={"etapa_id": etapa, "finalizado_em": day(20)}).status_code, 200)
        self.assertEqual(self.c.get(f"/api/sol/{aberto}").get_json()["item"]["finalizado_em"][:10], day(20))
        # validações
        for bad in ({"criado_em": day(1), "finalizado_em": day(5)},                      # finalização antes da abertura
                    {"criado_em": (dt.date.today() + dt.timedelta(days=5)).isoformat()},   # futuro
                    {"criado_em": "31/12/2025"}):                                         # formato inválido
            self.assertEqual(self.c.post("/api/sol", json={**base, **bad}).status_code, 400, bad)
        self.assertEqual(self.c.put(f"/api/sol/{aberto}/etapa", json={"etapa_id": etapa, "finalizado_em": day(60)}).status_code, 400)

    def test_12_enviar_candidato_para_unidades_ativas(self):
        ab = self.state()["pipeline"]["aberturas"][0]
        r = self.c.post("/api/units", json={"nome": ab["nome"], "uf": ab["uf"], "tipo": "CO", "situacao": "ativa", "desde": "2026-11-01",
                                            "razao_social": "Empresa Teste LTDA", "cnpj": "12.345.678/0001-90", "email": "x@y.com", "abertura_id": ab["id"]})
        self.assertEqual(r.status_code, 201)
        uid = r.get_json()["id"]
        st = self.state()
        self.assertEqual(next(a for a in st["pipeline"]["aberturas"] if a["id"] == ab["id"])["unidade_id"], uid)
        u = self.c.get(f"/api/units/{uid}").get_json()
        self.assertEqual((u["razao_social"], u["cnpj"], u["desde"], u["origem"]), ("Empresa Teste LTDA", "12.345.678/0001-90", "2026-11-01", "manual"))
        # editar só os campos básicos não apaga os cadastrais
        self.assertEqual(self.c.put(f"/api/units/{uid}", json={"nome": ab["nome"], "uf": ab["uf"], "tipo": "CO"}).status_code, 200)
        self.assertEqual(self.c.get(f"/api/units/{uid}").get_json()["razao_social"], "Empresa Teste LTDA")
        self.assertEqual(self.c.post("/api/units", json={"nome": "X", "uf": "SP", "desde": "01/11/2026"}).status_code, 400)

    def test_13_ocorrencia_foto_opcional(self):
        foto = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
        uid = self.c.post("/api/units", json={"nome": "Unidade foto", "uf": "SP"}).get_json()["id"]
        base = {"unit_id": uid, "titulo": "Noticia", "descricao": "Detalhes"}
        def item(iid):
            return next(i for i in self.state()["incidents"] if i["id"] == iid)
        for extra in ({}, {"foto": foto}):
            response = self.c.post("/api/incidents", json={**base, **extra})
            self.assertEqual(response.status_code, 201)
            iid = response.get_json()["id"]
            self.assertEqual(item(iid)["foto"], extra.get("foto", ""))
            self.assertEqual(self.c.put(f"/api/incidents/{iid}", json={**base, "titulo": "Editado"}).status_code, 200)
            self.assertEqual(item(iid)["foto"], extra.get("foto", ""))
            self.assertEqual(self.c.put(f"/api/incidents/{iid}", json={**base, "foto": ""}).status_code, 200)
            self.assertEqual(item(iid)["foto"], "")
            self.assertEqual(self.c.delete(f"/api/incidents/{iid}").status_code, 200)
            self.assertNotIn(iid, [i["id"] for i in self.state()["incidents"]])
        for bad in ("data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,aGVsbG8=", "data:image/png;base64,????", 42, "x" * 2800100):
            self.assertEqual(self.c.post("/api/incidents", json={**base, "foto": bad}).status_code, 400)


if __name__ == "__main__":
    unittest.main()
