"""Franchising - Team - servidor (Flask + SQLite).

Uso:
    python app.py            # sobe em http://127.0.0.1:5000
    python app.py --demo     # idem, populando dados de exemplo se o banco estiver vazio

Variaveis de ambiente opcionais:
    ACCESS_CODE   se definido, o site exige esse codigo para ler/editar (recomendado ao expor na internet)
    PORT          porta (padrao 5000)
"""
import json
import base64
import binascii
import gzip
import os
import re
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timezone

from flask import Flask, Response, g, jsonify, request, send_from_directory

import importer
import pipeline
import masters
import database

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("FRANQUIAS_DB") or os.path.join(BASE, "franquias.db")
ACCESS_CODE = os.environ.get("ACCESS_CODE", "").strip()
if os.environ.get("RENDER") and not ACCESS_CODE:
    raise RuntimeError("Defina ACCESS_CODE no Render antes de publicar o sistema.")
if os.environ.get("RENDER") and not database.postgres_enabled():
    raise RuntimeError("Defina DATABASE_URL no Render: SQLite local não é persistente no plano gratuito.")

UFS = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB",
       "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"]
SEVERIDADES = ["baixa", "media", "alta", "critica"]
STATUS_OC = ["aberta", "andamento", "resolvida"]
SITUACOES = ["ativa", "implantacao", "inativa", "fechada"]
UPLOAD_DIR = os.path.join(BASE, "uploads")
APP_VERSION = 10          # o site compara com esse numero e avisa se o servidor ficou desatualizado

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 30 * 1024 * 1024

# colunas extras da tabela units (vindas da planilha); todas TEXT
UNIT_EXTRA_COLS = ["chave", "sigla", "sit_planilha", "ponto", "aeroporto", "desde", "cnpj", "razao_social",
                   "endereco", "bairro", "cep", "telefone", "celular", "email", "email_gestor", "franqueado",
                   "equipe", "consultor", "funcionamento", "visitada", "triagem", "extra", "saiu_em", "unidade_master"]
# campos cadastrais que o formulário de unidade também grava (só entram no UPDATE quando vierem no envio)
UNIT_FORM_COLS = ["sigla", "ponto", "aeroporto", "desde", "cnpj", "razao_social", "franqueado", "unidade_master", "equipe", "consultor",
                  "email", "email_gestor", "telefone", "celular", "endereco", "bairro", "cep"]
UNIT_LIST_COLS = ("id,nome,tipo,uf,cidade,responsavel,situacao,sigla,ponto,aeroporto,desde,cnpj,razao_social,"
                  "franqueado,unidade_master,equipe,consultor,email,email_gestor,telefone,celular,endereco,bairro,cep,origem,saiu_em,"
                  "created_at,updated_at")


# ---------------------------------------------------------------- banco
def db():
    if "db" not in g:
        g.db = database.connect(DB_PATH)
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db(conn=None, close_connection=True):
    conn = conn if conn is not None else database.connect(DB_PATH)
    if database.postgres_enabled():
        conn.execute("SELECT pg_advisory_xact_lock(19482631)")
        exists = conn.execute("SELECT to_regclass('public.settings')").fetchone()[0]
        if exists and conn.execute("SELECT 1 FROM settings WHERE chave='cloud_schema_version' AND valor='1'").fetchone():
            conn.commit()
            if close_connection:
                conn.close()
            return
    conn.executescript(
        """
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS units (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL,
            tipo TEXT NOT NULL DEFAULT '',
            uf TEXT NOT NULL,
            cidade TEXT NOT NULL DEFAULT '',
            responsavel TEXT NOT NULL DEFAULT '',
            situacao TEXT NOT NULL DEFAULT 'ativa',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            updated_by TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
            titulo TEXT NOT NULL,
            categoria TEXT NOT NULL DEFAULT 'Outros',
            severidade TEXT NOT NULL DEFAULT 'media',
            status TEXT NOT NULL DEFAULT 'aberta',
            descricao TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            updated_by TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL DEFAULT '',
            resolved_at TEXT
        );
        CREATE TABLE IF NOT EXISTS log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            user TEXT NOT NULL,
            acao TEXT NOT NULL,
            detalhe TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ref_month TEXT NOT NULL,
            uploaded_at TEXT NOT NULL,
            uploaded_by TEXT NOT NULL,
            filename TEXT NOT NULL DEFAULT '',
            total INTEGER NOT NULL DEFAULT 0,
            novas INTEGER NOT NULL DEFAULT 0,
            saidas INTEGER NOT NULL DEFAULT 0,
            alteradas INTEGER NOT NULL DEFAULT 0,
            reativadas INTEGER NOT NULL DEFAULT 0,
            by_tipo TEXT NOT NULL DEFAULT '{}',
            primeira INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS unit_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_id INTEGER NOT NULL,
            unit_id INTEGER,
            chave TEXT, nome TEXT, tipo TEXT,
            kind TEXT NOT NULL,
            diff TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS ix_changes_snap ON unit_changes(snapshot_id);
        CREATE TABLE IF NOT EXISTS pipe_fases (
            id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, ordem INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS pipe_tipos (
            id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, ordem INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS pipe_campos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chave TEXT NOT NULL UNIQUE,
            label TEXT NOT NULL,
            fase_id INTEGER, tipo_id INTEGER,
            ordem INTEGER NOT NULL DEFAULT 0,
            kind TEXT NOT NULL DEFAULT 'status',
            papel TEXT);
        CREATE TABLE IF NOT EXISTS aberturas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chave TEXT NOT NULL UNIQUE,
            uf TEXT NOT NULL, nome TEXT NOT NULL,
            origem TEXT NOT NULL DEFAULT 'planilha',
            saiu_em TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT '',
            last_change_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS abertura_valores (
            abertura_id INTEGER NOT NULL REFERENCES aberturas(id) ON DELETE CASCADE,
            campo_id INTEGER NOT NULL REFERENCES pipe_campos(id) ON DELETE CASCADE,
            valor TEXT NOT NULL DEFAULT '',
            imp TEXT,
            updated_at TEXT, updated_by TEXT,
            PRIMARY KEY (abertura_id, campo_id));
        """
    )
    have = {r[1] for r in conn.execute("PRAGMA table_info(units)")}
    for col in UNIT_EXTRA_COLS:
        if col not in have:
            conn.execute(f"ALTER TABLE units ADD COLUMN {col} TEXT")
    if "origem" not in have:
        conn.execute("ALTER TABLE units ADD COLUMN origem TEXT NOT NULL DEFAULT 'manual'")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_units_chave ON units(chave) WHERE chave IS NOT NULL AND chave != ''")

    def add_col(table, col, ddl):
        if col in {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}:
            return False
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
        return True
    add_col("incidents", "foto", "TEXT NOT NULL DEFAULT ''")
    add_col("aberturas", "prioridade", "TEXT NOT NULL DEFAULT ''")
    add_col("aberturas", "unidade_id", "INTEGER")           # unidade ativa criada a partir deste candidato
    if add_col("pipe_campos", "pedir", "INTEGER NOT NULL DEFAULT 0"):          # padrao: campos do tipo Documentacao sao pedidos ao franqueado
        conn.execute("UPDATE pipe_campos SET pedir=1 WHERE tipo_id IN (SELECT id FROM pipe_tipos WHERE lower(nome) LIKE 'document%')")
    add_col("pipe_campos", "nivel", "TEXT NOT NULL DEFAULT 'media'")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS settings (chave TEXT PRIMARY KEY, valor TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS sol_categorias (
            id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, cor TEXT NOT NULL DEFAULT '#1f4fd8', ordem INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS sol_subcategorias (
            id INTEGER PRIMARY KEY AUTOINCREMENT, categoria_id INTEGER NOT NULL, nome TEXT NOT NULL, ordem INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS sol_etapas (
            id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, ordem INTEGER NOT NULL DEFAULT 0, final INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS solicitacoes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            titulo TEXT NOT NULL,
            categoria_id INTEGER NOT NULL, subcategoria_id INTEGER,
            etapa_id INTEGER NOT NULL,
            unidade_id INTEGER, unidade_txt TEXT NOT NULL DEFAULT '',
            solicitante TEXT NOT NULL DEFAULT '', responsavel TEXT NOT NULL DEFAULT '',
            prioridade TEXT NOT NULL DEFAULT '', jira TEXT NOT NULL DEFAULT '', descricao TEXT NOT NULL DEFAULT '',
            criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL, finalizado_em TEXT,
            created_by TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
        CREATE INDEX IF NOT EXISTS ix_sol_etapa ON solicitacoes(etapa_id);
        CREATE TABLE IF NOT EXISTS sol_hist (
            id INTEGER PRIMARY KEY AUTOINCREMENT, sol_id INTEGER NOT NULL, ts TEXT NOT NULL, user TEXT NOT NULL,
            evento TEXT NOT NULL, detalhe TEXT NOT NULL DEFAULT '');
        CREATE INDEX IF NOT EXISTS ix_solhist ON sol_hist(sol_id);
        """
    )
    add_col("solicitacoes", "link", "TEXT NOT NULL DEFAULT ''")
    if not conn.execute("SELECT 1 FROM settings WHERE chave='sol_seeded'").fetchone():        # categorias e etapas iniciais (editaveis)
        seed = [("Jira", "#2b5c85", ["Salesforce", "Cadastro no portal", "Reset de senha", "Atribuição de acesso"]),
                ("Unidade", "#1d7a46", ["Troca de CNPJ", "Troca de endereço", "Troca de franqueado / responsável", "Fechamento / encerramento"]),
                ("Outros", "#5d646d", ["Dúvida", "Solicitação geral"])]
        for i, (nome, cor, subs) in enumerate(seed, 1):
            cid = conn.execute("INSERT INTO sol_categorias (nome,cor,ordem) VALUES (?,?,?)", (nome, cor, i)).lastrowid
            for j, sn in enumerate(subs, 1):
                conn.execute("INSERT INTO sol_subcategorias (categoria_id,nome,ordem) VALUES (?,?,?)", (cid, sn, j))
        for i, (nome, fin) in enumerate([("Nova", 0), ("Em análise", 0), ("Aguardando franqueado", 0), ("Em andamento (Jira)", 0),
                                         ("Aguardando validação", 0), ("Finalizada", 1), ("Cancelada", 1)], 1):
            conn.execute("INSERT INTO sol_etapas (nome,ordem,final) VALUES (?,?,?)", (nome, i, fin))
        conn.execute("INSERT INTO settings (chave,valor) VALUES ('sol_seeded','1')")
    masters.init(conn)
    source = os.path.join(BASE, "usuarios fraction (2).csv")
    if not database.postgres_enabled() and not os.environ.get("FRANQUIAS_DB") and os.path.isfile(source) and not conn.execute("SELECT 1 FROM settings WHERE chave='masters_seeded'").fetchone():
        with open(source, "rb") as file:
            rows = masters.parse(file.read())
        masters.import_rows(conn, rows, datetime.now(timezone.utc).isoformat(timespec="seconds"), "importação inicial")
        conn.execute("INSERT INTO settings (chave,valor) VALUES ('masters_seeded','1')")
    if database.postgres_enabled():
        conn.execute("INSERT INTO settings (chave,valor) VALUES ('cloud_schema_version','1') ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor")
    conn.commit()
    if close_connection:
        conn.close()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def who():
    name = (request.headers.get("X-User") or "").strip()
    # o header chega em latin-1; o front envia URL-encoded
    from urllib.parse import unquote
    return unquote(name)[:60] or "anônimo"


def log(acao, detalhe):
    db().execute("INSERT INTO log (ts, user, acao, detalhe) VALUES (?,?,?,?)",
                 (now(), who(), acao, detalhe[:300]))


def clean(d, key, maxlen=200):
    return str(d.get(key, "") or "").strip()[:maxlen]


@app.before_request
def check_access():
    g.started_at = time.perf_counter()
    if not request.path.startswith("/api/"):
        return None
    if ACCESS_CODE and request.headers.get("X-Access-Code", "") != ACCESS_CODE:
        return jsonify(error="codigo de acesso invalido"), 401
    return None


@app.after_request
def response_metrics(response):
    elapsed = (time.perf_counter() - g.get("started_at", time.perf_counter())) * 1000
    conn = g.get("db")
    db_ms = getattr(conn, "query_seconds", 0) * 1000
    queries = getattr(conn, "query_count", 0)
    response.headers["Server-Timing"] = f"app;dur={elapsed:.1f}, db;dur={db_ms:.1f}"
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
        if elapsed > 1500:
            app.logger.warning("Requisição lenta %s: %.0f ms; banco %.0f ms; consultas %s", request.path, elapsed, db_ms, queries)
        if response.mimetype == "application/json" and request.accept_encodings["gzip"] > 0 and len(response.get_data()) > 1024:
            response.set_data(gzip.compress(response.get_data(), compresslevel=5))
            response.headers["Content-Encoding"] = "gzip"
            response.vary.add("Accept-Encoding")
    return response


# ---------------------------------------------------------------- estado
@app.get("/api/state")
def state():
    c = db()
    units = [dict(r) for r in c.execute(f"SELECT {UNIT_LIST_COLS} FROM units ORDER BY nome COLLATE NOCASE")]
    incidents = [dict(r) for r in c.execute("SELECT * FROM incidents ORDER BY created_at DESC, id DESC")]
    logs = [dict(r) for r in c.execute("SELECT * FROM log ORDER BY id DESC LIMIT 100")]
    snaps = [dict(r) for r in c.execute("SELECT * FROM snapshots ORDER BY id DESC LIMIT 60")]
    for s in snaps:
        s["by_tipo"] = json.loads(s["by_tipo"] or "{}")
    latest = []
    if snaps and not snaps[0]["primeira"]:
        latest = [dict(r) for r in c.execute(
            "SELECT unit_id,chave,nome,tipo,kind FROM unit_changes WHERE snapshot_id=? AND kind IN ('nova','saiu','reativada')"
            " LIMIT 40", (snaps[0]["id"],))]
    return jsonify(units=units, incidents=incidents, log=logs, snapshots=snaps, latest_changes=latest,
                   pipeline=pipeline.state(c), sol=sol_state(c), sol_units=sol_units(c), ufs=UFS, server_time=now())


@app.get("/api/rev")
def rev():
    """Assinatura barata do estado: o front so baixa /api/state quando ela muda."""
    c = db()
    row = c.execute("SELECT (SELECT COALESCE(MAX(id),0) FROM log), (SELECT COUNT(*) FROM units), "
                    "(SELECT COUNT(*) FROM incidents), (SELECT COALESCE(MAX(id),0) FROM snapshots)").fetchone()
    return jsonify(rev="|".join(str(value) for value in row))


@app.get("/api/ping")
def ping():
    return jsonify(ok=True, protected=bool(ACCESS_CODE), version=APP_VERSION)


@app.get("/healthz")
def healthz():
    return jsonify(ok=True)


@app.get("/api/units/export")
def export_units():
    """Excel com TODAS as colunas: as padronizadas + todas as colunas extras que vieram das abas."""
    from io import BytesIO
    from openpyxl import Workbook
    rows = [dict(r) for r in db().execute("SELECT * FROM units ORDER BY tipo, nome COLLATE NOCASE")]
    extras = []
    for r in rows:
        try:
            r["_ex"] = json.loads(r.get("extra") or "{}")
        except ValueError:
            r["_ex"] = {}
        for k in r["_ex"]:
            if k not in extras:
                extras.append(k)
    base = [("nome", "Nome"), ("tipo", "Tipo"), ("sigla", "Sigla"), ("uf", "UF"), ("cidade", "Cidade"), ("situacao", "Situação"),
            ("saiu_em", "Saiu da planilha em"), ("responsavel", "Responsável (franqueado / gerente / parceiro operacional)"),
            ("unidade_master", "Unidade responsável (master)"), ("ponto", "Ponto"), ("aeroporto", "Aeroporto / IATA"),
            ("desde", "Desde (abertura)"), ("cnpj", "CNPJ"), ("razao_social", "Razão social"), ("endereco", "Endereço"),
            ("bairro", "Bairro"), ("cep", "CEP"), ("telefone", "Telefone"), ("celular", "Celulares gestores"),
            ("email", "E-mail oficial"), ("email_gestor", "E-mail gestor"), ("equipe", "Equipe"), ("consultor", "Consultor de campo"),
            ("funcionamento", "Funcionamento"), ("visitada", "Visitada"), ("triagem", "Triagem")]
    wb = Workbook(write_only=True)
    ws = wb.create_sheet("Unidades")
    ws.append([h for _, h in base] + extras)
    for r in rows:
        ws.append([r.get(k) or "" for k, _ in base] + [r["_ex"].get(k, "") for k in extras])
    bio = BytesIO()
    wb.save(bio)
    return Response(bio.getvalue(), mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": "attachment; filename=unidades-completo.xlsx"})


@app.get("/api/units/<int:uid>")
def get_unit(uid):
    r = db().execute("SELECT * FROM units WHERE id=?", (uid,)).fetchone()
    if not r:
        return jsonify(error="unidade não encontrada"), 404
    d = dict(r)
    try:
        d["extra"] = json.loads(d.get("extra") or "{}")
    except ValueError:
        d["extra"] = {}
    d["solicitacoes"] = [dict(r) for r in db().execute(
        "SELECT s.id, s.titulo, s.criado_em, s.finalizado_em, e.nome AS etapa, e.final AS final, c.nome AS categoria "
        "FROM solicitacoes s JOIN sol_etapas e ON e.id=s.etapa_id JOIN sol_categorias c ON c.id=s.categoria_id "
        "WHERE s.unidade_id=? ORDER BY s.criado_em DESC LIMIT 100", (uid,))]
    return jsonify(d)


# ---------------------------------------------------------------- planilha mensal
def _month(v):
    v = (v or "").strip()
    return v if re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", v) else datetime.now().strftime("%Y-%m")


def _live_planilha(conn):
    return conn.execute("SELECT COUNT(*) FROM units WHERE origem='planilha' AND saiu_em IS NULL"
                        " AND situacao NOT IN ('fechada','inativa')").fetchone()[0]


@app.post("/api/import/preview")
def import_preview():
    f = request.files.get("file")
    if not f or not f.filename.lower().endswith((".xlsx", ".xlsm")):
        return jsonify(error="envie um arquivo .xlsx"), 400
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    for old in os.listdir(UPLOAD_DIR):                       # limpa pendencias com mais de 1 dia
        p = os.path.join(UPLOAD_DIR, old)
        if os.path.getmtime(p) < time.time() - 86400:
            os.remove(p)
    token = uuid.uuid4().hex
    path = os.path.join(UPLOAD_DIR, token + ".xlsx")
    f.save(path)
    try:
        parsed = importer.parse_workbook(path, UFS)
    except Exception as e:                                   # arquivo corrompido, senha etc.
        os.remove(path)
        return jsonify(error=f"não consegui ler a planilha: {e}"), 400
    if not parsed["rows"]:
        os.remove(path)
        return jsonify(error="nenhuma unidade encontrada na planilha"), 400
    c = db()
    plan = importer.plan_import(c, parsed["rows"])
    prev, month = _live_planilha(c), _month(request.form.get("ref_month"))
    warnings = list(parsed["warnings"])
    queda = prev >= 50 and len(parsed["rows"]) < prev * 0.7
    if queda:
        warnings.insert(0, f"ATENÇÃO: a planilha tem {len(parsed['rows'])} unidades e o sistema tem {prev} ativas. "
                           f"Confira se é o arquivo certo antes de confirmar.")
    if c.execute("SELECT 1 FROM snapshots WHERE ref_month=?", (month,)).fetchone():
        warnings.append(f"Já existe uma atualização para {month}; esta será registrada como nova versão do mês.")
    by_tipo = {}
    for r in parsed["rows"].values():
        by_tipo[r["tipo"]] = by_tipo.get(r["tipo"], 0) + 1
    return jsonify(token=token, filename=f.filename, ref_month=month, alerta_queda=queda,
                   total=len(parsed["rows"]), sheets=parsed["sheets"], by_tipo=by_tipo,
                   novas=len(plan["new"]), saidas=len(plan["gone"]), sem_mudanca=plan["unchanged"],
                   alteradas=sum(1 for u in plan["upd"] if not u["back"]),
                   reativadas=sum(1 for u in plan["upd"] if u["back"]),
                   primeira=prev == 0 and not c.execute("SELECT 1 FROM units WHERE origem='planilha' LIMIT 1").fetchone(),
                   warnings=warnings, errors=parsed["errors"][:40], n_errors=len(parsed["errors"]),
                   changes=importer.preview_changes(plan))


@app.post("/api/import/commit")
def import_commit():
    d = request.get_json(silent=True) or {}
    token = str(d.get("token", ""))
    if not re.fullmatch(r"[0-9a-f]{32}", token):
        return jsonify(error="token inválido"), 400
    path = os.path.join(UPLOAD_DIR, token + ".xlsx")
    if not os.path.exists(path):
        return jsonify(error="a análise expirou; envie a planilha de novo"), 400
    c = db()
    parsed = importer.parse_workbook(path, UFS)
    prev = _live_planilha(c)
    if prev >= 50 and len(parsed["rows"]) < prev * 0.7 and not d.get("force"):
        return jsonify(error="queda grande no total; marque a confirmação para prosseguir"), 409
    plan = importer.plan_import(c, parsed["rows"])
    snap = importer.apply_plan(c, plan, _month(d.get("ref_month")), str(d.get("filename", ""))[:200], who(), now())
    log("planilha atualizada",
        f'{_month(d.get("ref_month"))}: {len(plan["new"])} novas, {len(plan["gone"])} saíram, '
        f'{len(plan["upd"])} alteradas — total {snap["total"]}')
    c.commit()
    try:
        os.remove(path)
    except OSError:
        pass
    return jsonify(ok=True, snapshot=snap["id"], total=snap["total"])


@app.get("/api/snapshots/<int:sid>/changes")
def snapshot_changes(sid):
    rows = db().execute("SELECT unit_id,chave,nome,tipo,kind,diff FROM unit_changes WHERE snapshot_id=?"
                        " ORDER BY CASE kind WHEN 'saiu' THEN 0 WHEN 'reativada' THEN 1 WHEN 'alterada' THEN 2 ELSE 3 END, nome"
                        " LIMIT 1500", (sid,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["diff"] = json.loads(d["diff"] or "{}")
        out.append(d)
    return jsonify(changes=out)


# ---------------------------------------------------------------- unidades
def unit_payload(d):
    nome = clean(d, "nome", 120)
    uf = clean(d, "uf", 2).upper()
    if not nome:
        return None, "nome é obrigatório"
    if uf not in UFS:
        return None, f"UF inválida: {uf or '(vazio)'}"
    situacao = clean(d, "situacao", 20).lower() or "ativa"
    if situacao not in SITUACOES:
        situacao = "ativa"
    extras = {k: clean(d, k, 200) for k in UNIT_FORM_COLS if k in d}
    if extras.get("desde") and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", extras["desde"]):
        return None, "data de abertura inválida (use o calendário)"
    return dict(nome=nome, tipo=clean(d, "tipo", 60), uf=uf, cidade=clean(d, "cidade", 80),
                responsavel=clean(d, "responsavel", 80), situacao=situacao, extras=extras), None


def _set_unit_extras(uid, extras):
    if extras:       # nomes de coluna vêm da lista fixa UNIT_FORM_COLS, nunca do cliente
        db().execute(f"UPDATE units SET {','.join(k + '=?' for k in extras)} WHERE id=?", (*extras.values(), uid))


@app.post("/api/units")
def create_unit():
    p, err = unit_payload(request.get_json(silent=True) or {})
    if err:
        return jsonify(error=err), 400
    t = now()
    cur = db().execute(
        "INSERT INTO units (nome,tipo,uf,cidade,responsavel,situacao,created_at,updated_at,updated_by) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (p["nome"], p["tipo"], p["uf"], p["cidade"], p["responsavel"], p["situacao"], t, t, who()))
    uid = cur.lastrowid
    _set_unit_extras(uid, p["extras"])
    aid = _int((request.get_json(silent=True) or {}).get("abertura_id"))
    ab = db().execute("SELECT nome FROM aberturas WHERE id=?", (aid,)).fetchone() if aid else None
    if ab:                                       # enviada do pipeline de aberturas
        db().execute("UPDATE aberturas SET unidade_id=?, updated_at=?, updated_by=? WHERE id=?", (uid, t, who(), aid))
        log("candidato enviado às unidades ativas", f'{ab["nome"]} → {p["nome"]}')
    log("unidade criada", f'{p["nome"]} ({p["uf"]})')
    db().commit()
    return jsonify(id=uid), 201


@app.post("/api/units/bulk")
def bulk_units():
    body = request.get_json(silent=True) or {}
    rows, offset = body.get("rows", []), int(body.get("offset", 0) or 0)
    if not isinstance(rows, list) or len(rows) > 20000:
        return jsonify(error="lista inválida (máx. 20000 linhas por envio)"), 400
    ok, erros = 0, []
    t = now()
    for i, row in enumerate(rows, start=offset + 1):
        p, err = unit_payload(row if isinstance(row, dict) else {})
        if err:
            erros.append(f"linha {i}: {err}")
            continue
        db().execute(
            "INSERT INTO units (nome,tipo,uf,cidade,responsavel,situacao,created_at,updated_at,updated_by) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (p["nome"], p["tipo"], p["uf"], p["cidade"], p["responsavel"], p["situacao"], t, t, who()))
        ok += 1
    if ok:
        log("importação", f"{ok} unidades importadas")
    db().commit()
    return jsonify(importadas=ok, erros=erros[:50])


@app.put("/api/units/<int:uid>")
def update_unit(uid):
    p, err = unit_payload(request.get_json(silent=True) or {})
    if err:
        return jsonify(error=err), 400
    cur = db().execute(
        "UPDATE units SET nome=?,tipo=?,uf=?,cidade=?,responsavel=?,situacao=?,updated_at=?,updated_by=? WHERE id=?",
        (p["nome"], p["tipo"], p["uf"], p["cidade"], p["responsavel"], p["situacao"], now(), who(), uid))
    if cur.rowcount == 0:
        return jsonify(error="unidade não encontrada"), 404
    _set_unit_extras(uid, p["extras"])
    log("unidade editada", f'{p["nome"]} ({p["uf"]})')
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/units/<int:uid>")
def delete_unit(uid):
    row = db().execute("SELECT nome FROM units WHERE id=?", (uid,)).fetchone()
    if not row:
        return jsonify(error="unidade não encontrada"), 404
    db().execute("DELETE FROM units WHERE id=?", (uid,))
    log("unidade excluída", row["nome"])
    db().commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------- ocorrencias
def incident_payload(d):
    titulo = clean(d, "titulo", 140)
    if not titulo:
        return None, "título é obrigatório"
    try:
        unit_id = int(d.get("unit_id"))
    except (TypeError, ValueError):
        return None, "selecione a unidade"
    if not db().execute("SELECT 1 FROM units WHERE id=?", (unit_id,)).fetchone():
        return None, "unidade não encontrada"
    foto = d.get("foto", "")
    if not isinstance(foto, str):
        return None, "foto inválida"
    if foto:
        match = re.fullmatch(r"data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)", foto)
        if not match or len(foto) > 2800000:
            return None, "use uma foto PNG, JPEG ou WebP de até 2 MB"
        try:
            raw = base64.b64decode(match[2], validate=True)
        except (ValueError, binascii.Error):
            return None, "foto inválida"
        valid = {"png": raw.startswith(b"\x89PNG\r\n\x1a\n"),
                 "jpeg": raw.startswith(b"\xff\xd8\xff"),
                 "webp": raw.startswith(b"RIFF") and raw[8:12] == b"WEBP"}
        if len(raw) > 2 * 1024 * 1024 or not valid[match[1]]:
            return None, "foto inválida ou maior que 2 MB"
    sev = clean(d, "severidade", 10).lower()
    st = clean(d, "status", 12).lower()
    return dict(unit_id=unit_id, titulo=titulo, categoria=clean(d, "categoria", 60) or "Outros",
                severidade=sev if sev in SEVERIDADES else "media",
                status=st if st in STATUS_OC else "aberta",
                descricao=clean(d, "descricao", 2000), foto=foto), None


def unit_name(uid):
    r = db().execute("SELECT nome FROM units WHERE id=?", (uid,)).fetchone()
    return r["nome"] if r else "?"


@app.post("/api/incidents")
def create_incident():
    p, err = incident_payload(request.get_json(silent=True) or {})
    if err:
        return jsonify(error=err), 400
    t = now()
    resolved = t if p["status"] == "resolvida" else None
    cur = db().execute(
        "INSERT INTO incidents (unit_id,titulo,categoria,severidade,status,descricao,created_at,updated_at,"
        "updated_by,created_by,resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (p["unit_id"], p["titulo"], p["categoria"], p["severidade"], p["status"], p["descricao"], t, t,
         who(), who(), resolved))
    db().execute("UPDATE incidents SET foto=? WHERE id=?", (p["foto"], cur.lastrowid))
    log(f'ocorrência {p["severidade"].upper()}', f'{unit_name(p["unit_id"])}: {p["titulo"]}')
    db().commit()
    return jsonify(id=cur.lastrowid), 201


@app.put("/api/incidents/<int:iid>")
def update_incident(iid):
    old = db().execute("SELECT * FROM incidents WHERE id=?", (iid,)).fetchone()
    if not old:
        return jsonify(error="ocorrência não encontrada"), 404
    data = request.get_json(silent=True) or {}
    data.setdefault("foto", old["foto"])
    data.setdefault("status", old["status"])
    p, err = incident_payload(data)
    if err:
        return jsonify(error=err), 400
    t = now()
    if p["status"] == "resolvida":
        resolved = old["resolved_at"] or t
    else:
        resolved = None
    db().execute(
        "UPDATE incidents SET unit_id=?,titulo=?,categoria=?,severidade=?,status=?,descricao=?,updated_at=?,"
        "updated_by=?,resolved_at=? WHERE id=?",
        (p["unit_id"], p["titulo"], p["categoria"], p["severidade"], p["status"], p["descricao"], t, who(),
         resolved, iid))
    db().execute("UPDATE incidents SET foto=? WHERE id=?", (p["foto"], iid))
    acao = "ocorrência editada"
    log(acao, f'{unit_name(p["unit_id"])}: {p["titulo"]}')
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/incidents/<int:iid>")
def delete_incident(iid):
    row = db().execute("SELECT titulo, unit_id FROM incidents WHERE id=?", (iid,)).fetchone()
    if not row:
        return jsonify(error="ocorrência não encontrada"), 404
    db().execute("DELETE FROM incidents WHERE id=?", (iid,))
    log("ocorrência excluída", f'{unit_name(row["unit_id"])}: {row["titulo"]}')
    db().commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------- novas franquias (pipeline de abertura)
def _save_upload():
    f = request.files.get("file")
    if not f or not f.filename.lower().endswith((".xlsx", ".xlsm")):
        return None, None, (jsonify(error="envie um arquivo .xlsx"), 400)
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    token = uuid.uuid4().hex
    path = os.path.join(UPLOAD_DIR, token + ".xlsx")
    f.save(path)
    return token, path, f.filename


@app.post("/api/pipeline/preview")
def pipeline_preview():
    token, path, fname = _save_upload()
    if token is None:
        return fname
    sheet = (request.form.get("sheet") or "start_26").strip()
    try:
        parsed = pipeline.parse_start(path, sheet, UFS)
    except Exception as e:
        os.remove(path)
        return jsonify(error=str(e)), 400
    if not parsed["rows"]:
        os.remove(path)
        return jsonify(error="nenhum candidato encontrado (linhas 4 em diante)"), 400
    pl = pipeline.plan(db(), parsed)
    queda = pl["n_existing"] >= 20 and len(parsed["rows"]) < pl["n_existing"] * 0.7
    warnings = []
    if queda:
        warnings.append(f"ATENÇÃO: a planilha tem {len(parsed['rows'])} candidatos e o sistema tem {pl['n_existing']}. Confira o arquivo.")
    if pl["novos_campos"]:
        warnings.append(f"{len(pl['novos_campos'])} coluna(s) nova(s) serão criadas: "
                        + ", ".join(c["label"] for c in pl["novos_campos"][:8]) + ("…" if len(pl["novos_campos"]) > 8 else ""))
    return jsonify(token=token, filename=fname, sheet=parsed["sheet"], alerta_queda=queda, total=len(parsed["rows"]),
                   n_campos=len(parsed["campos"]), fases=parsed["fases"], novas=len(pl["novas"]), saiu=len(pl["saiu"]),
                   voltaram=len(pl["voltaram"]), com_mudanca=len(pl["mudancas"]), valores_mudados=pl["mudados"],
                   warnings=warnings, errors=parsed["errors"][:30], changes=pipeline.preview(pl, parsed),
                   primeira=pl["n_existing"] == 0 and not pl["mudancas"])


@app.post("/api/pipeline/commit")
def pipeline_commit():
    d = request.get_json(silent=True) or {}
    token = str(d.get("token", ""))
    if not re.fullmatch(r"[0-9a-f]{32}", token):
        return jsonify(error="token inválido"), 400
    path = os.path.join(UPLOAD_DIR, token + ".xlsx")
    if not os.path.exists(path):
        return jsonify(error="a análise expirou; envie a planilha de novo"), 400
    c = db()
    try:
        parsed = pipeline.parse_start(path, str(d.get("sheet") or "start_26"), UFS)
    except Exception as e:
        return jsonify(error=str(e)), 400
    pl = pipeline.plan(c, parsed)
    if pl["n_existing"] >= 20 and len(parsed["rows"]) < pl["n_existing"] * 0.7 and not d.get("force"):
        return jsonify(error="queda grande no total; marque a confirmação para prosseguir"), 409
    pipeline.apply(c, parsed, pl, who(), now())
    log("novas franquias: planilha", f'{len(pl["novas"])} novas, {len(pl["saiu"])} saíram, {len(pl["mudancas"])} com mudanças '
                                    f'({pl["mudados"]} campos)')
    c.commit()
    try:
        os.remove(path)
    except OSError:
        pass
    return jsonify(ok=True)


def _ab_name(aid):
    r = db().execute("SELECT nome FROM aberturas WHERE id=?", (aid,)).fetchone()
    return r["nome"] if r else None


@app.post("/api/aberturas")
def create_abertura():
    d = request.get_json(silent=True) or {}
    nome, uf = clean(d, "nome", 120), clean(d, "uf", 2).upper()
    if not nome or uf not in UFS:
        return jsonify(error="informe a localidade/unidade e uma UF válida"), 400
    t = now()
    chave = f"{uf}|{importer.nh(nome)}"
    if db().execute("SELECT 1 FROM aberturas WHERE chave=?", (chave,)).fetchone():
        chave += f"#{uuid.uuid4().hex[:4]}"
    cur = db().execute("INSERT INTO aberturas (chave,uf,nome,origem,created_at,updated_at,updated_by,last_change_at)"
                       " VALUES (?,?,?,'manual',?,?,?,?)", (chave, uf, nome, t, t, who(), t))
    log("candidato criado", f"{nome} ({uf})")
    db().commit()
    return jsonify(id=cur.lastrowid), 201


@app.put("/api/aberturas/<int:aid>")
def update_abertura(aid):
    d = request.get_json(silent=True) or {}
    nome, uf = clean(d, "nome", 120), clean(d, "uf", 2).upper()
    if not nome or uf not in UFS:
        return jsonify(error="informe a localidade/unidade e uma UF válida"), 400
    cur = db().execute("UPDATE aberturas SET nome=?, uf=?, updated_at=?, updated_by=? WHERE id=?", (nome, uf, now(), who(), aid))
    if cur.rowcount == 0:
        return jsonify(error="candidato não encontrado"), 404
    log("candidato editado", f"{nome} ({uf})")
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/aberturas/<int:aid>")
def delete_abertura(aid):
    nome = _ab_name(aid)
    if nome is None:
        return jsonify(error="candidato não encontrado"), 404
    db().execute("DELETE FROM aberturas WHERE id=?", (aid,))
    log("candidato excluído", nome)
    db().commit()
    return jsonify(ok=True)


@app.put("/api/aberturas/<int:aid>/valor")
def set_valor(aid):
    d = request.get_json(silent=True) or {}
    try:
        cid = int(d.get("campo_id"))
    except (TypeError, ValueError):
        return jsonify(error="campo inválido"), 400
    valor = clean(d, "valor", 500)
    c = db()
    campo = c.execute("SELECT label FROM pipe_campos WHERE id=?", (cid,)).fetchone()
    nome = _ab_name(aid)
    if not campo or nome is None:
        return jsonify(error="candidato ou campo não encontrado"), 404
    old = c.execute("SELECT valor FROM abertura_valores WHERE abertura_id=? AND campo_id=?", (aid, cid)).fetchone()
    if (old["valor"] if old else "") == valor:
        return jsonify(ok=True, changed=False)
    t = now()
    c.execute("INSERT INTO abertura_valores (abertura_id,campo_id,valor,updated_at,updated_by) VALUES (?,?,?,?,?)"
              " ON CONFLICT(abertura_id,campo_id) DO UPDATE SET valor=excluded.valor, updated_at=excluded.updated_at,"
              " updated_by=excluded.updated_by", (aid, cid, valor, t, who()))
    c.execute("UPDATE aberturas SET last_change_at=?, updated_at=?, updated_by=? WHERE id=?", (t, t, who(), aid))
    log("candidato atualizado", f'{nome} — {campo["label"]}: {(old["valor"] if old else "") or "vazio"} → {valor or "vazio"}')
    c.commit()
    return jsonify(ok=True, changed=True)


PRIORIDADES = ("", "urgente", "alta", "media", "baixa")


@app.put("/api/aberturas/<int:aid>/prioridade")
def set_prioridade(aid):
    p = clean(request.get_json(silent=True) or {}, "prioridade", 10).lower()
    nome = _ab_name(aid)
    if p not in PRIORIDADES:
        return jsonify(error="prioridade inválida"), 400
    if nome is None:
        return jsonify(error="candidato não encontrado"), 404
    db().execute("UPDATE aberturas SET prioridade=?, updated_at=?, updated_by=? WHERE id=?", (p, now(), who(), aid))
    log("prioridade de abertura", f"{nome}: {p or 'sem prioridade'}")
    db().commit()
    return jsonify(ok=True)


# configuracao do pipeline: fases, tipos e campos
PIPE_TABLES = {"fases": "pipe_fases", "tipos": "pipe_tipos", "campos": "pipe_campos"}


@app.post("/api/pipe/<kind>")
def pipe_create(kind):
    if kind not in PIPE_TABLES:
        return jsonify(error="tipo inválido"), 404
    d = request.get_json(silent=True) or {}
    c, tb = db(), PIPE_TABLES[kind]
    order = c.execute(f"SELECT COALESCE(MAX(ordem),0)+1 FROM {tb}").fetchone()[0]
    if kind == "campos":
        label = clean(d, "label", 100)
        if not label:
            return jsonify(error="informe o nome do campo"), 400
        k = d.get("kind") if d.get("kind") in ("status", "data", "texto") else "status"
        nivel = d.get("nivel") if d.get("nivel") in ("alta", "media", "baixa") else "media"
        cur = c.execute("INSERT INTO pipe_campos (chave,label,fase_id,tipo_id,ordem,kind,pedir,nivel) VALUES (?,?,?,?,?,?,?,?)",
                        (f"manual:{uuid.uuid4().hex[:8]}", label, d.get("fase_id") or None, d.get("tipo_id") or None, order, k,
                         1 if str(d.get("pedir")) in ("1", "true", "True") else 0, nivel))
    else:
        nome = clean(d, "nome", 80)
        if not nome:
            return jsonify(error="informe o nome"), 400
        cur = c.execute(f"INSERT INTO {tb} (nome, ordem) VALUES (?,?)", (nome, order))
    log("pipeline configurado", f"{kind[:-1]} criado: {clean(d, 'nome') or clean(d, 'label')}")
    c.commit()
    return jsonify(id=cur.lastrowid), 201


@app.put("/api/pipe/<kind>/<int:pid>")
def pipe_update(kind, pid):
    if kind not in PIPE_TABLES:
        return jsonify(error="tipo inválido"), 404
    d = request.get_json(silent=True) or {}
    tb, sets, vals = PIPE_TABLES[kind], [], []
    allowed = {"fases": ["nome"], "tipos": ["nome"], "campos": ["label", "fase_id", "tipo_id", "kind", "pedir", "nivel"]}[kind]
    for f in allowed:
        if f in d:
            v = d[f]
            if f in ("nome", "label"):
                v = clean(d, f, 100)
                if not v:
                    return jsonify(error="o nome não pode ficar vazio"), 400
            elif f == "kind":
                if v not in ("status", "data", "texto"):
                    return jsonify(error="tipo de campo inválido"), 400
            elif f == "pedir":
                v = 1 if str(v) in ("1", "true", "True") else 0
            elif f == "nivel":
                if v not in ("alta", "media", "baixa"):
                    return jsonify(error="nível inválido"), 400
            else:
                v = int(v) if v not in (None, "", 0, "0") else None
            sets.append(f"{f}=?")
            vals.append(v)
    if not sets:
        return jsonify(ok=True)
    cur = db().execute(f"UPDATE {tb} SET {','.join(sets)} WHERE id=?", [*vals, pid])
    if cur.rowcount == 0:
        return jsonify(error="não encontrado"), 404
    log("pipeline configurado", f"{kind[:-1]} #{pid} editado")
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/pipe/<kind>/<int:pid>")
def pipe_delete(kind, pid):
    if kind not in PIPE_TABLES:
        return jsonify(error="tipo inválido"), 404
    c, col = db(), {"fases": "fase_id", "tipos": "tipo_id"}.get(kind)
    if col and c.execute(f"SELECT 1 FROM pipe_campos WHERE {col}=?", (pid,)).fetchone():
        return jsonify(error="mova ou exclua os campos desta " + kind[:-1] + " antes"), 409
    c.execute(f"DELETE FROM {PIPE_TABLES[kind]} WHERE id=?", (pid,))
    log("pipeline configurado", f"{kind[:-1]} #{pid} excluído")
    c.commit()
    return jsonify(ok=True)


@app.post("/api/pipe/<kind>/reorder")
def pipe_reorder(kind):
    if kind not in PIPE_TABLES:
        return jsonify(error="tipo inválido"), 404
    ids = (request.get_json(silent=True) or {}).get("ids", [])
    if not isinstance(ids, list):
        return jsonify(error="lista inválida"), 400
    for pos, i in enumerate(ids):
        db().execute(f"UPDATE {PIPE_TABLES[kind]} SET ordem=? WHERE id=?", (pos + 1, int(i)))
    db().commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------- solicitacoes (chamados das franquias)
SOL_PRI = ("", "baixa", "media", "alta", "urgente")
SOL_CFG = {"categorias": "sol_categorias", "subcategorias": "sol_subcategorias", "etapas": "sol_etapas"}


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def sol_state(c):
    return dict(
        categorias=[dict(r) for r in c.execute("SELECT * FROM sol_categorias ORDER BY ordem, id")],
        subcategorias=[dict(r) for r in c.execute("SELECT * FROM sol_subcategorias ORDER BY ordem, id")],
        etapas=[dict(r) for r in c.execute("SELECT * FROM sol_etapas ORDER BY ordem, id")],
        abertas=[dict(r) for r in c.execute("SELECT s.* FROM solicitacoes s JOIN sol_etapas e ON e.id=s.etapa_id "
                                            "WHERE e.final=0 ORDER BY s.criado_em")],
        jira_base=(c.execute("SELECT valor FROM settings WHERE chave='jira_base'").fetchone() or {"valor": ""})["valor"])


JIRA_KEY = re.compile(r"[A-Z][A-Z0-9_]+-\d+")


def _jira_fields(jira, link):
    """Aceita a URL colada no campo da chave; extrai a chave da URL quando só veio o link."""
    jira, link = (jira or "").strip(), (link or "").strip()
    if re.match(r"^https?://", jira):
        link, jira = link or jira, ""
    if not re.fullmatch(r"https?://\S+", link):
        link = ""
    if link and not jira:
        keys = JIRA_KEY.findall(link)
        jira = keys[-1] if keys else ""
    return jira[:80], link[:500]


def _learn_jira_base(link):
    """Primeiro link colado no formato https://empresa.atlassian.net/browse/ABC-1 já define o endereço base do Jira."""
    m = re.match(r"^(https?://[^/\s]+/browse/)[A-Z][A-Z0-9_]+-\d+", link or "")
    if m and not db().execute("SELECT valor FROM settings WHERE chave='jira_base' AND valor != ''").fetchone():
        db().execute("INSERT INTO settings (chave,valor) VALUES ('jira_base',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor", (m.group(1),))


def _cutoff(days):
    from datetime import timedelta
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")


def _date_iso(value):
    """Data do calendário (AAAA-MM-DD) -> ISO ao meio-dia UTC (para o dia não virar por causa do fuso). Vazio -> None."""
    v = str(value or "").strip()
    if not v:
        return None
    try:
        return datetime.strptime(v[:10], "%Y-%m-%d").strftime("%Y-%m-%dT12:00:00+00:00")
    except ValueError:
        raise ValueError("data inválida (use o calendário)")


def _sol_dates(d, criado_atual=None):
    """Datas retroativas (registrar chamados antigos): nada no futuro e a finalização nunca vem antes da abertura."""
    cr, fi = _date_iso(d.get("criado_em")), _date_iso(d.get("finalizado_em"))
    today = now()[:10]
    for rotulo, v in (("abertura", cr), ("finalização", fi)):
        if v and v[:10] > today:
            raise ValueError(f"a data de {rotulo} não pode estar no futuro")
    if fi and fi[:10] < (cr or criado_atual or "")[:10]:
        raise ValueError("a data de finalização não pode ser anterior à abertura")
    return cr, fi


def sol_units(c):
    """Solicitações por unidade (total, últimos 90 dias, abertas, última) — alimenta cartões, filtros e o ranking do painel."""
    rows = c.execute(
        "SELECT s.unidade_id AS u, COUNT(*) AS tot, SUM(CASE WHEN s.criado_em >= ? THEN 1 ELSE 0 END) AS d90, SUM(CASE WHEN e.final=0 THEN 1 ELSE 0 END) AS ab, MAX(s.criado_em) AS ultima "
        "FROM solicitacoes s JOIN sol_etapas e ON e.id=s.etapa_id WHERE s.unidade_id IS NOT NULL GROUP BY s.unidade_id", (_cutoff(90),))
    return {str(r["u"]): dict(tot=r["tot"], d90=r["d90"] or 0, ab=r["ab"] or 0, ultima=r["ultima"]) for r in rows}


def _sol_hist(sid, evento, detalhe=""):
    db().execute("INSERT INTO sol_hist (sol_id, ts, user, evento, detalhe) VALUES (?,?,?,?,?)", (sid, now(), who(), evento, detalhe[:500]))


def _sol_clean(d):
    c = db()
    titulo = clean(d, "titulo", 160)
    if not titulo:
        return None, "informe o título"
    cat = _int(d.get("categoria_id"))
    if cat is None or not c.execute("SELECT 1 FROM sol_categorias WHERE id=?", (cat,)).fetchone():
        return None, "escolha a categoria"
    sub = _int(d.get("subcategoria_id"))
    if sub is not None and not c.execute("SELECT 1 FROM sol_subcategorias WHERE id=? AND categoria_id=?", (sub, cat)).fetchone():
        sub = None
    uid = _int(d.get("unidade_id"))
    if uid is not None and not c.execute("SELECT 1 FROM units WHERE id=?", (uid,)).fetchone():
        uid = None
    pri = clean(d, "prioridade", 10).lower()
    jira, link = _jira_fields(d.get("jira"), d.get("link"))
    return dict(titulo=titulo, categoria_id=cat, subcategoria_id=sub, unidade_id=uid, unidade_txt="" if uid else clean(d, "unidade_txt", 120),
                solicitante=clean(d, "solicitante", 100), responsavel=clean(d, "responsavel", 100),
                prioridade=pri if pri in SOL_PRI else "", jira=jira, link=link, descricao=clean(d, "descricao", 4000)), None


@app.post("/api/sol")
def sol_create():
    d = request.get_json(silent=True) or {}
    p, err = _sol_clean(d)
    if err:
        return jsonify(error=err), 400
    try:
        cr, fi = _sol_dates(d)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    c = db()
    et = _int(d.get("etapa_id"))
    if fi:                                      # com data de finalização, o chamado já nasce encerrado
        row = (c.execute("SELECT id FROM sol_etapas WHERE id=? AND final=1", (et,)).fetchone() if et else None) \
            or c.execute("SELECT id FROM sol_etapas WHERE final=1 ORDER BY ordem, id LIMIT 1").fetchone()
        if not row:
            return jsonify(error="crie uma etapa de finalização em Configurar"), 400
    else:
        row = c.execute("SELECT id FROM sol_etapas WHERE id=? AND final=0", (et,)).fetchone() if et else None
        row = row or c.execute("SELECT id FROM sol_etapas WHERE final=0 ORDER BY ordem, id LIMIT 1").fetchone()
        if not row:
            return jsonify(error="configure ao menos uma etapa aberta"), 400
    t = now()
    criado = cr or t
    cur = c.execute(
        "INSERT INTO solicitacoes (titulo,categoria_id,subcategoria_id,unidade_id,unidade_txt,solicitante,responsavel,prioridade,jira,link,"
        "descricao,etapa_id,criado_em,atualizado_em,finalizado_em,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (p["titulo"], p["categoria_id"], p["subcategoria_id"], p["unidade_id"], p["unidade_txt"], p["solicitante"], p["responsavel"],
         p["prioridade"], p["jira"], p["link"], p["descricao"], row["id"], criado, fi or (cr and criado) or t, fi, who(), who()))
    _learn_jira_base(p["link"])
    retro = f' (registro retroativo: aberta em {criado[:10]}{", finalizada em " + fi[:10] if fi else ""})' if cr or fi else ""
    _sol_hist(cur.lastrowid, "aberta", p["titulo"] + retro)
    log("solicitação aberta", p["titulo"])
    c.commit()
    return jsonify(id=cur.lastrowid), 201


@app.put("/api/sol/<int:sid>")
def sol_update(sid):
    body = request.get_json(silent=True) or {}
    p, err = _sol_clean(body)
    if err:
        return jsonify(error=err), 400
    c = db()
    atual = c.execute("SELECT s.criado_em, e.final FROM solicitacoes s JOIN sol_etapas e ON e.id=s.etapa_id WHERE s.id=?", (sid,)).fetchone()
    if not atual:
        return jsonify(error="solicitação não encontrada"), 404
    try:
        cr, fi = _sol_dates(body, atual["criado_em"])
    except ValueError as e:
        return jsonify(error=str(e)), 400
    cur = c.execute(
        "UPDATE solicitacoes SET titulo=?,categoria_id=?,subcategoria_id=?,unidade_id=?,unidade_txt=?,solicitante=?,responsavel=?,"
        "prioridade=?,jira=?,link=?,descricao=?,atualizado_em=?,updated_by=? WHERE id=?",
        (p["titulo"], p["categoria_id"], p["subcategoria_id"], p["unidade_id"], p["unidade_txt"], p["solicitante"], p["responsavel"],
         p["prioridade"], p["jira"], p["link"], p["descricao"], now(), who(), sid))
    _learn_jira_base(p["link"])
    if cr:
        c.execute("UPDATE solicitacoes SET criado_em=? WHERE id=?", (cr, sid))
    if fi and atual["final"]:                   # a data de finalização só se aplica a chamado já encerrado (senão vem junto da mudança de etapa)
        c.execute("UPDATE solicitacoes SET finalizado_em=? WHERE id=?", (fi, sid))
    _sol_hist(sid, "editada", "datas ajustadas" if cr or (fi and atual["final"]) else "")
    log("solicitação editada", p["titulo"])
    c.commit()
    return jsonify(ok=True)


@app.put("/api/sol/<int:sid>/etapa")
def sol_etapa(sid):
    c, body = db(), request.get_json(silent=True) or {}
    et = c.execute("SELECT * FROM sol_etapas WHERE id=?", (_int(body.get("etapa_id")),)).fetchone()
    cur = c.execute("SELECT s.titulo, s.criado_em, e.nome AS etapa FROM solicitacoes s JOIN sol_etapas e ON e.id=s.etapa_id WHERE s.id=?", (sid,)).fetchone()
    if not et or not cur:
        return jsonify(error="solicitação ou etapa não encontrada"), 404
    try:
        _, fi = _sol_dates({"finalizado_em": body.get("finalizado_em")}, cur["criado_em"])
    except ValueError as e:
        return jsonify(error=str(e)), 400
    t = now()
    fin = (fi or t) if et["final"] else None
    c.execute("UPDATE solicitacoes SET etapa_id=?, atualizado_em=?, finalizado_em=?, updated_by=? WHERE id=?", (et["id"], t, fin, who(), sid))
    _sol_hist(sid, "finalizada" if et["final"] else "etapa", f'{cur["etapa"]} → {et["nome"]}' + (f' (em {fi[:10]})' if fi else ""))
    log("solicitação: " + ("finalizada" if et["final"] else "etapa"), f'{cur["titulo"]}: {cur["etapa"]} → {et["nome"]}')
    c.commit()
    return jsonify(ok=True)


@app.post("/api/sol/<int:sid>/nota")
def sol_nota(sid):
    texto = clean(request.get_json(silent=True) or {}, "texto", 1000)
    row = db().execute("SELECT titulo FROM solicitacoes WHERE id=?", (sid,)).fetchone()
    if not row or not texto:
        return jsonify(error="escreva a anotação"), 400
    _sol_hist(sid, "nota", texto)
    db().execute("UPDATE solicitacoes SET atualizado_em=?, updated_by=? WHERE id=?", (now(), who(), sid))
    log("solicitação: anotação", row["titulo"])
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/sol/<int:sid>")
def sol_delete(sid):
    row = db().execute("SELECT titulo FROM solicitacoes WHERE id=?", (sid,)).fetchone()
    if not row:
        return jsonify(error="solicitação não encontrada"), 404
    db().execute("DELETE FROM solicitacoes WHERE id=?", (sid,))
    db().execute("DELETE FROM sol_hist WHERE sol_id=?", (sid,))
    log("solicitação excluída", row["titulo"])
    db().commit()
    return jsonify(ok=True)


@app.get("/api/sol/ranking")
def sol_ranking():
    """Unidades que mais nos acionam: solicitações no período (0 = todo o histórico), com filtro opcional de categoria."""
    dias, cat, c = _int(request.args.get("dias")) or 0, _int(request.args.get("cat")), db()
    where, args = ["s.unidade_id IS NOT NULL"], []
    if dias > 0:
        where.append("s.criado_em >= ?")
        args.append(_cutoff(dias))
    if cat:
        where.append("s.categoria_id = ?")
        args.append(cat)
    w = " AND ".join(where)
    rows = [dict(r) for r in c.execute(
        "SELECT u.id, u.nome, u.uf, u.tipo, u.sigla, COUNT(*) AS tot, SUM(e.final=0) AS ab, MAX(s.criado_em) AS ultima, "
        "AVG(CASE WHEN e.final=1 THEN julianday(s.finalizado_em) - julianday(s.criado_em) END) AS media_dias "
        "FROM solicitacoes s JOIN sol_etapas e ON e.id=s.etapa_id JOIN units u ON u.id=s.unidade_id "
        f"WHERE {w} GROUP BY u.id ORDER BY tot DESC, ab DESC, u.nome LIMIT 300", args)]
    top = {}
    for r in c.execute("SELECT s.unidade_id AS u, COALESCE(sc.nome, ca.nome) AS nome, COUNT(*) AS n FROM solicitacoes s "
                       "JOIN sol_categorias ca ON ca.id=s.categoria_id LEFT JOIN sol_subcategorias sc ON sc.id=s.subcategoria_id "
                       f"JOIN sol_etapas e ON e.id=s.etapa_id WHERE {w} GROUP BY s.unidade_id, 2 ORDER BY n DESC", args):
        top.setdefault(r["u"], []).append(f'{r["nome"]} ({r["n"]})')
    inc = {r["unit_id"]: r["n"] for r in c.execute("SELECT unit_id, COUNT(*) AS n FROM incidents WHERE status != 'resolvida' GROUP BY unit_id")}
    for r in rows:
        r["top"] = top.get(r["id"], [])[:3]
        r["ocorrencias_abertas"] = inc.get(r["id"], 0)
        r["media_dias"] = round(r["media_dias"], 1) if r["media_dias"] is not None else None
    sem = c.execute("SELECT COUNT(*) FROM solicitacoes s WHERE s.unidade_id IS NULL" + (" AND s.criado_em >= ?" if dias > 0 else "")
                    + (" AND s.categoria_id = ?" if cat else ""), [a for a in args]).fetchone()[0]
    return jsonify(rows=rows, sem_unidade=sem)


@app.get("/api/sol/finalizadas")
def sol_finalizadas():
    dias = _int(request.args.get("dias")) or 0
    sql = ("SELECT s.*, e.nome AS etapa_nome FROM solicitacoes s JOIN sol_etapas e ON e.id=s.etapa_id WHERE e.final=1")
    args = []
    if dias > 0:
        from datetime import timedelta
        sql += " AND (s.finalizado_em >= ? OR s.finalizado_em IS NULL)"
        args.append((datetime.now(timezone.utc) - timedelta(days=dias)).isoformat(timespec="seconds"))
    rows = db().execute(sql + " ORDER BY s.finalizado_em DESC LIMIT 5000", args).fetchall()
    return jsonify(items=[dict(r) for r in rows])


@app.get("/api/sol/<int:sid>")
def sol_get(sid):
    c = db()
    r = c.execute("SELECT s.*, e.nome AS etapa_nome, e.final AS etapa_final FROM solicitacoes s JOIN sol_etapas e ON e.id=s.etapa_id WHERE s.id=?", (sid,)).fetchone()
    if not r:
        return jsonify(error="solicitação não encontrada"), 404
    hist = [dict(h) for h in c.execute("SELECT ts,user,evento,detalhe FROM sol_hist WHERE sol_id=? ORDER BY id DESC", (sid,))]
    return jsonify(item=dict(r), hist=hist)


@app.post("/api/solcfg/<kind>")
def solcfg_create(kind):
    if kind not in SOL_CFG:
        return jsonify(error="inválido"), 404
    d, c, tb = request.get_json(silent=True) or {}, db(), SOL_CFG[kind]
    nome = clean(d, "nome", 80)
    if not nome:
        return jsonify(error="informe o nome"), 400
    order = c.execute(f"SELECT COALESCE(MAX(ordem),0)+1 FROM {tb}").fetchone()[0]
    if kind == "categorias":
        cor = d.get("cor") if re.fullmatch(r"#[0-9a-fA-F]{6}", str(d.get("cor", ""))) else "#2b5c85"
        cur = c.execute("INSERT INTO sol_categorias (nome,cor,ordem) VALUES (?,?,?)", (nome, cor, order))
    elif kind == "subcategorias":
        cat = _int(d.get("categoria_id"))
        if cat is None or not c.execute("SELECT 1 FROM sol_categorias WHERE id=?", (cat,)).fetchone():
            return jsonify(error="categoria inválida"), 400
        cur = c.execute("INSERT INTO sol_subcategorias (categoria_id,nome,ordem) VALUES (?,?,?)", (cat, nome, order))
    else:
        cur = c.execute("INSERT INTO sol_etapas (nome,ordem,final) VALUES (?,?,?)", (nome, order, 1 if str(d.get("final")) in ("1", "true") else 0))
    log("solicitações: configuração", f"{kind[:-1] if kind != 'etapas' else 'etapa'} criado: {nome}")
    c.commit()
    return jsonify(id=cur.lastrowid), 201


@app.put("/api/solcfg/<kind>/<int:pid>")
def solcfg_update(kind, pid):
    if kind not in SOL_CFG:
        return jsonify(error="inválido"), 404
    d, sets, vals = request.get_json(silent=True) or {}, [], []
    if "nome" in d:
        nome = clean(d, "nome", 80)
        if not nome:
            return jsonify(error="o nome não pode ficar vazio"), 400
        sets.append("nome=?"); vals.append(nome)
    if kind == "categorias" and "cor" in d:
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", str(d["cor"])):
            return jsonify(error="cor inválida"), 400
        sets.append("cor=?"); vals.append(d["cor"])
    if kind == "etapas" and "final" in d:
        sets.append("final=?"); vals.append(1 if str(d["final"]) in ("1", "true") else 0)
    if kind == "subcategorias" and "categoria_id" in d:
        if not db().execute("SELECT 1 FROM sol_categorias WHERE id=?", (_int(d["categoria_id"]),)).fetchone():
            return jsonify(error="categoria inválida"), 400
        sets.append("categoria_id=?"); vals.append(int(d["categoria_id"]))
    if not sets:
        return jsonify(ok=True)
    cur = db().execute(f"UPDATE {SOL_CFG[kind]} SET {','.join(sets)} WHERE id=?", [*vals, pid])
    if cur.rowcount == 0:
        return jsonify(error="não encontrado"), 404
    log("solicitações: configuração", f"{kind} #{pid} editado")
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/solcfg/<kind>/<int:pid>")
def solcfg_delete(kind, pid):
    if kind not in SOL_CFG:
        return jsonify(error="inválido"), 404
    c = db()
    use = {"categorias": "SELECT 1 FROM solicitacoes WHERE categoria_id=?", "subcategorias": "SELECT 1 FROM solicitacoes WHERE subcategoria_id=?",
           "etapas": "SELECT 1 FROM solicitacoes WHERE etapa_id=?"}[kind]
    if c.execute(use, (pid,)).fetchone():
        return jsonify(error="há solicitações usando este item: mova-as antes de excluir"), 409
    if kind == "categorias":
        c.execute("DELETE FROM sol_subcategorias WHERE categoria_id=?", (pid,))
    c.execute(f"DELETE FROM {SOL_CFG[kind]} WHERE id=?", (pid,))
    log("solicitações: configuração", f"{kind} #{pid} excluído")
    c.commit()
    return jsonify(ok=True)


@app.post("/api/solcfg/<kind>/reorder")
def solcfg_reorder(kind):
    if kind not in SOL_CFG:
        return jsonify(error="inválido"), 404
    for pos, i in enumerate((request.get_json(silent=True) or {}).get("ids", [])):
        db().execute(f"UPDATE {SOL_CFG[kind]} SET ordem=? WHERE id=?", (pos + 1, int(i)))
    db().commit()
    return jsonify(ok=True)


@app.put("/api/settings")
def settings_put():
    base = clean(request.get_json(silent=True) or {}, "jira_base", 200)
    if base and not re.match(r"^https?://", base):
        return jsonify(error="o endereço precisa começar com http:// ou https://"), 400
    db().execute("INSERT INTO settings (chave,valor) VALUES ('jira_base',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor", (base,))
    log("solicitações: configuração", "endereço do Jira atualizado")
    db().commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------- estaticos
@app.get("/")
def index():
    return send_from_directory(os.path.join(BASE, "static"), "index.html")


@app.get("/static/<path:name>")
def static_files(name):
    return send_from_directory(os.path.join(BASE, "static"), name)


# ---------------------------------------------------------------- demo
def seed_demo():
    conn = database.connect(DB_PATH)
    if conn.execute("SELECT COUNT(*) FROM units").fetchone()[0]:
        conn.close()
        return
    t = now()
    units = [
        ("Hub São Paulo - Barra Funda", "Hub", "SP", "São Paulo", "Carlos Mendes"),
        ("Franquia Campinas", "Franquia", "SP", "Campinas", "Ana Souza"),
        ("Franquia Belo Horizonte", "Franquia", "MG", "Belo Horizonte", "Rafael Lima"),
        ("Ponto de Coleta Curitiba", "Ponto de Coleta", "PR", "Curitiba", "Juliana Prado"),
        ("Franquia Salvador", "Franquia", "BA", "Salvador", "Marcos Teles"),
        ("Hub Recife", "Hub", "PE", "Recife", "Patrícia Alves"),
        ("Franquia Porto Alegre", "Franquia", "RS", "Porto Alegre", "Diego Rocha"),
        ("Ponto de Coleta Goiânia", "Ponto de Coleta", "GO", "Goiânia", "Fernanda Dias"),
        ("Franquia Manaus", "Franquia", "AM", "Manaus", "Paulo Nogueira"),
        ("Franquia Fortaleza", "Franquia", "CE", "Fortaleza", "Luciana Reis"),
    ]
    for u in units:
        conn.execute("INSERT INTO units (nome,tipo,uf,cidade,responsavel,situacao,created_at,updated_at,updated_by)"
                     " VALUES (?,?,?,?,?,'ativa',?,?,'demo')", (*u, t, t))
    oc = [
        (3, "Incêndio na unidade - sem informações de feridos", "Sinistro", "critica", "aberta",
         "Unidade atingida por incêndio na madrugada. Operação parada. Aguardando contato do responsável."),
        (5, "Atraso recorrente de coletas", "Operacional", "media", "andamento", "Três dias de atraso acima de 4h."),
        (1, "Alvará vencendo em 15 dias", "Fiscal", "alta", "aberta", "Renovação ainda não protocolada."),
        (9, "Veículo de frota sem seguro", "Frota", "baixa", "resolvida", "Apólice regularizada."),
    ]
    for o in oc:
        conn.execute("INSERT INTO incidents (unit_id,titulo,categoria,severidade,status,descricao,created_at,"
                     "updated_at,updated_by,created_by) VALUES (?,?,?,?,?,?,?,?,'demo','demo')", (*o, t, t))
    conn.execute("INSERT INTO log (ts,user,acao,detalhe) VALUES (?,?,?,?)", (t, "demo", "demo", "dados de exemplo carregados"))
    conn.commit()
    conn.close()


if database.postgres_enabled():
    from psycopg import OperationalError
    from psycopg.errors import QueryCanceled, LockNotAvailable
    from psycopg_pool import PoolTimeout, TooManyRequests
    def database_unavailable(error):
        app.logger.warning("Banco indisponível: %s", type(error).__name__)
        return jsonify(error="O banco demorou a responder ou está indisponível. Tente novamente em alguns instantes."), 503
    for error_type in (OperationalError, QueryCanceled, LockNotAvailable, PoolTimeout, TooManyRequests):
        app.register_error_handler(error_type, database_unavailable)

masters.register(app, db, now, who, log)
if os.environ.get("FRANQUIAS_SKIP_INIT") != "1":
    init_db()
if "--demo" in sys.argv:
    seed_demo()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    print(f"Franchising - Team em http://127.0.0.1:{port}"
          + ("  [protegido por ACCESS_CODE]" if ACCESS_CODE else "  [SEM código de acesso]"))
    app.run(host="127.0.0.1", port=port, threaded=True)
