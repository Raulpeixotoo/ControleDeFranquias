import io
import os
import tempfile
import unittest
from unittest.mock import patch

from openpyxl import Workbook
import app
import masters


class Masters(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db_patch = patch.object(app, "DB_PATH", os.path.join(self.tmp.name, "test.db"))
        self.db_patch.start()
        self.addCleanup(self.db_patch.stop)
        with patch.dict(os.environ, {"FRANQUIAS_DB": app.DB_PATH}):
            app.init_db()
        self.client = app.app.test_client()

    def workbook(self, rows):
        wb = Workbook()
        wb.active.append(["OPER_MATRIC", "OPER_NOME", "PONTO_CODI", "ENABLED", "SEGUNDO_FATOR", "FATOR_AUTENTICACAO"])
        for row in rows:
            wb.active.append(row)
        out = io.BytesIO(); wb.save(out); return out.getvalue()

    def upload(self, rows):
        return self.client.post("/api/masters/import", data={"file": (io.BytesIO(self.workbook(rows)), "export.csv")})

    def unit(self, nome, ponto, situacao="ativa"):
        return self.client.post("/api/units", json={"nome": nome, "uf": "SP", "ponto": ponto, "situacao": situacao}).get_json()["id"]

    def test_profiles_flags_links_and_reimport(self):
        uid = self.unit("Ativa", "00123")
        self.unit("Fechada", "123", "fechada")
        rows = [("m1", "Master pendente", 123, 1, "N", 2), ("m2", "Master regular", "123", 0, "S", 2),
                ("o1", "Operacional", "999", 1, "N", 1)]
        self.assertEqual(self.upload(rows).status_code, 200)
        data = self.client.get("/api/masters?perfil=2&pendentes=1").get_json()
        self.assertEqual(data["total"], 1)
        item = data["items"][0]
        self.assertEqual(item["perfil"], "Master")
        self.assertEqual([u["id"] for u in item["unidades"]], [uid])
        self.assertEqual(data["summary"]["inativos"], 1)
        self.assertEqual(data["summary"]["masters_pendentes"], 1)
        self.assertEqual(self.client.get("/api/masters?enabled=0").get_json()["total"], 1)
        self.assertEqual(self.client.get("/api/masters?vinculo=sem_unidade").get_json()["total"], 1)
        self.unit("Outra ativa", "123")
        self.assertEqual(self.client.get("/api/masters?vinculo=ambiguo").get_json()["total"], 2)
        self.assertEqual(self.client.put(f"/api/masters/{item['id']}", json={"nome": item["nome"], "enabled": 1, "segundo_fator": "S"}).status_code, 200)
        self.assertEqual(self.client.get("/api/masters?pendentes=1").get_json()["total"], 0)
        self.assertEqual(self.upload(rows[:1]).status_code, 200)
        self.assertEqual(self.client.get("/api/masters").get_json()["total"], 3)

    def test_invalid_import_is_atomic_and_csv_supported(self):
        self.assertEqual(self.upload([("1", "Valid", 1, 1, "N", 2), ("2", "Invalid", 2, 5, "N", 2)]).status_code, 400)
        self.assertEqual(self.client.get("/api/masters").get_json()["total"], 0)
        raw = b"OPER_MATRIC;OPER_NOME;PONTO_CODI;ENABLED;SEGUNDO_FATOR;FATOR_AUTENTICACAO\n1;Test;0001;1;N;2\n"
        self.assertEqual(masters.parse(raw)[0][2], "1")
        self.assertEqual(masters.point(0), "0")
        self.assertEqual(self.client.get("/api/masters?page=no").status_code, 400)

    def test_create_delete_validation_and_duplicate(self):
        uid = self.unit("Unidade cadastro", "123")
        payload = {"nome": "Master novo", "matricula": "M123", "ponto": "00123", "enabled": "1", "segundo_fator": "N", "fator_autenticacao": "2"}
        self.assertEqual(self.client.post("/api/masters", json={**payload, "nome": " "}).status_code, 400)
        self.assertEqual(self.client.post("/api/masters", json={**payload, "fator_autenticacao": "9"}).status_code, 400)
        response = self.client.post("/api/masters", json=payload)
        self.assertEqual(response.status_code, 201)
        mid = response.get_json()["id"]
        item = self.client.get("/api/masters?pendentes=1").get_json()["items"][0]
        self.assertEqual(item["unidades"][0]["id"], uid)
        self.assertTrue(item["pendencia_master"])
        self.assertEqual(self.client.post("/api/masters", json={**payload, "ponto": "123"}).status_code, 409)
        self.assertEqual(self.client.delete(f"/api/masters/{mid}").status_code, 200)
        self.assertEqual(self.client.get("/api/masters").get_json()["total"], 0)
        self.assertEqual(self.client.delete(f"/api/masters/{mid}").status_code, 404)
        self.assertEqual(self.client.get(f"/api/units/{uid}").status_code, 200)
