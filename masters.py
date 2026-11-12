"""Cadastro de usuários e ligação dinâmica com unidades ativas pelo ponto."""
import csv
import io
import re
import sqlite3
from collections import Counter, defaultdict

from flask import jsonify, request
from openpyxl import load_workbook


def point(value):
    value = str(value if value is not None else "").strip()
    if re.fullmatch(r"\d+\.0+", value):
        value = value.split(".")[0]
    return str(int(value)) if value.isdigit() else value


def init(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS master_users (
        id INTEGER PRIMARY KEY, matricula TEXT NOT NULL, nome TEXT NOT NULL,
        ponto TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        segundo_fator TEXT NOT NULL DEFAULT 'N', fator_autenticacao TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
        UNIQUE(matricula,ponto))""")


def parse(raw):
    if raw.startswith(b"PK"):
        book = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        try:
            data = list(book.active.values)
        finally:
            book.close()
        if not data:
            raise ValueError("Planilha vazia.")
        headers = [str(h or "").strip().upper() for h in data[0]]
        rows = [dict(zip(headers, r)) for r in data[1:] if any(v is not None for v in r)]
    else:
        for encoding in ("utf-8-sig", "cp1252"):
            try:
                text = raw.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        else:
            raise ValueError("Não foi possível ler o arquivo.")
        dialect = csv.Sniffer().sniff(text[:8000], delimiters=";,\t")
        reader = csv.DictReader(io.StringIO(text), dialect=dialect)
        headers = [str(h).strip().upper() for h in (reader.fieldnames or [])]
        rows = [{str(k).strip().upper(): v for k, v in r.items()} for r in reader]
    required = {"OPER_MATRIC", "OPER_NOME", "PONTO_CODI", "ENABLED", "SEGUNDO_FATOR", "FATOR_AUTENTICACAO"}
    if not required.issubset(headers):
        raise ValueError("Colunas necessárias: " + ", ".join(sorted(required)))
    result = []
    seen = set()
    for n, row in enumerate(rows, 2):
        matricula = str(row.get("OPER_MATRIC") or "").strip()
        nome = str(row.get("OPER_NOME") or "").strip()
        ponto = point(row.get("PONTO_CODI"))
        enabled = str(row.get("ENABLED")).strip()
        segundo = str(row.get("SEGUNDO_FATOR") or "N").strip().upper()
        fator = str(row.get("FATOR_AUTENTICACAO") or "").strip()
        if not matricula or not nome or not ponto or enabled not in ("0", "1") or segundo not in ("S", "N"):
            raise ValueError(f"Dados inválidos na linha {n}.")
        if (matricula, ponto) in seen:
            raise ValueError(f"Matrícula e ponto repetidos na linha {n}.")
        seen.add((matricula, ponto))
        result.append((matricula, nome, ponto, int(enabled), segundo, fator))
    if not result:
        raise ValueError("Arquivo sem usuários.")
    return result


def import_rows(conn, rows, stamp, user):
    conn.executemany("""INSERT INTO master_users
        (matricula,nome,ponto,enabled,segundo_fator,fator_autenticacao,updated_at,updated_by)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(matricula,ponto) DO UPDATE SET
        nome=excluded.nome,enabled=excluded.enabled,segundo_fator=excluded.segundo_fator,
        fator_autenticacao=excluded.fator_autenticacao,updated_at=excluded.updated_at,updated_by=excluded.updated_by""",
        [(*r, stamp, user) for r in rows])


def register(app, db, now, who, log):
    @app.post("/api/masters")
    def create():
        d = request.get_json(silent=True) or {}
        nome = str(d.get("nome") or "").strip()
        matricula = str(d.get("matricula") or "").strip()
        ponto = point(d.get("ponto"))
        enabled = str(d.get("enabled", "1"))
        segundo = d.get("segundo_fator", "N")
        fator = str(d.get("fator_autenticacao", ""))
        if not nome or len(nome) > 200 or not matricula or len(matricula) > 100 or not ponto or len(ponto) > 50 or enabled not in ("0", "1") or segundo not in ("S", "N") or fator not in ("1", "2", "3", "4"):
            return jsonify(error="Informe nome, matrícula, ponto, perfil e situação válidos."), 400
        try:
            cur = db().execute("""INSERT INTO master_users
                (matricula,nome,ponto,enabled,segundo_fator,fator_autenticacao,updated_at,updated_by)
                VALUES (?,?,?,?,?,?,?,?)""", (matricula,nome,ponto,int(enabled),segundo,fator,now(),who()))
        except sqlite3.IntegrityError:
            db().rollback()
            return jsonify(error="Já existe um usuário com essa matrícula nesse ponto."), 409
        log("usuário criado", f"Matrícula {matricula} · ponto {ponto}")
        db().commit()
        return jsonify(id=cur.lastrowid), 201

    @app.delete("/api/masters/<int:uid>")
    def delete(uid):
        old = db().execute("SELECT matricula,ponto FROM master_users WHERE id=?", (uid,)).fetchone()
        if not old:
            return jsonify(error="Usuário não encontrado"), 404
        db().execute("DELETE FROM master_users WHERE id=?", (uid,))
        log("usuário excluído", f"Matrícula {old['matricula']} · ponto {old['ponto']}")
        db().commit()
        return jsonify(ok=True)

    @app.get("/api/masters")
    def listing():
        conn = db()
        by_point = defaultdict(list)
        for u in conn.execute("SELECT id,nome,ponto,uf,sigla FROM units WHERE situacao NOT IN ('fechada','inativa') AND COALESCE(saiu_em,'')=''"):
            if point(u["ponto"]):
                by_point[point(u["ponto"])].append(dict(u))
        rows = []
        for r in conn.execute("SELECT * FROM master_users ORDER BY nome COLLATE NOCASE,id"):
            item = dict(r)
            item["perfil"] = {"1": "Operacional", "2": "Master"}.get(item["fator_autenticacao"], "Código " + item["fator_autenticacao"])
            item["pendencia_master"] = item["fator_autenticacao"] == "2" and item["segundo_fator"] != "S"
            item["unidades"] = by_point[item["ponto"]]
            item["vinculo"] = "vinculado" if len(item["unidades"]) == 1 else "ambiguo" if item["unidades"] else "sem_unidade"
            rows.append(item)
        counts = Counter(i["vinculo"] for i in rows)
        summary = dict(total=len(rows), pontos=len({i["ponto"] for i in rows}), ativos=sum(i["enabled"] for i in rows),
                       masters=sum(i["fator_autenticacao"] == "2" for i in rows),
                       masters_pendentes=sum(i["pendencia_master"] for i in rows),
                       inativos=sum(not i["enabled"] for i in rows), **counts)
        q = request.args.get("q", "").strip().casefold()
        vinculo = request.args.get("vinculo", "")
        enabled = request.args.get("enabled", "")
        segundo = request.args.get("segundo_fator", "")
        perfil = request.args.get("perfil", "")
        pendentes = request.args.get("pendentes", "") == "1"
        rows = [i for i in rows if (not vinculo or i["vinculo"] == vinculo)
                and (not perfil or i["fator_autenticacao"] == perfil)
                and (not pendentes or i["pendencia_master"])
                and (not enabled or str(i["enabled"]) == enabled)
                and (not segundo or i["segundo_fator"] == segundo)
                and (not q or q in " ".join([i["nome"], i["matricula"], i["ponto"], *[u["nome"] for u in i["unidades"]]]).casefold())]
        try:
            page = max(1, int(request.args.get("page", 1)))
        except ValueError:
            return jsonify(error="Página inválida"), 400
        total = len(rows)
        page = min(page, max(1, (total + 49) // 50))
        return jsonify(items=rows[(page-1)*50:page*50], total=total, page=page, pages=max(1,(total+49)//50), summary=summary)

    @app.post("/api/masters/import")
    def upload():
        file = request.files.get("file")
        if not file:
            return jsonify(error="Selecione a planilha."), 400
        try:
            rows = parse(file.read())
        except Exception:
            return jsonify(error="Arquivo inválido. Use Excel ou CSV com as seis colunas do cadastro de usuários."), 400
        import_rows(db(), rows, now(), who())
        log("usuários importados", f"{len(rows)} usuários; registros ausentes foram preservados")
        db().commit()
        return jsonify(total=len(rows))

    @app.put("/api/masters/<int:uid>")
    def update(uid):
        old = db().execute("SELECT * FROM master_users WHERE id=?", (uid,)).fetchone()
        if not old:
            return jsonify(error="Usuário não encontrado"), 404
        d = request.get_json(silent=True) or {}
        nome = str(d.get("nome", "")).strip()
        enabled = d.get("enabled")
        segundo = d.get("segundo_fator")
        if not nome or len(nome)>200 or str(enabled) not in ("0","1") or segundo not in ("S","N"):
            return jsonify(error="Informe nome, situação e segundo fator válidos."), 400
        db().execute("UPDATE master_users SET nome=?,enabled=?,segundo_fator=?,updated_at=?,updated_by=? WHERE id=?",
                     (nome,int(enabled),segundo,now(),who(),uid))
        log("usuário editado", f"Matrícula {old['matricula']} · ponto {old['ponto']}")
        db().commit()
        return jsonify(ok=True)
