"""SQLite local e PostgreSQL remoto, com conexões reutilizadas e SQL compatível."""
import os
import re
import sqlite3
import threading
import time
from decimal import Decimal

_pools = {}
_pool_lock = threading.Lock()
ID_TABLES = {"units", "incidents", "log", "snapshots", "unit_changes", "pipe_fases", "pipe_tipos",
             "pipe_campos", "aberturas", "sol_categorias", "sol_subcategorias", "sol_etapas",
             "solicitacoes", "sol_hist", "master_users"}


def postgres_enabled():
    return bool(os.environ.get("DATABASE_URL", "").strip())


def pool_stats():
    keys = ("pool_size", "pool_available", "requests_waiting", "connections_errors", "requests_errors")
    with _pool_lock:
        pools = list(_pools.values())
    stats = [pool.get_stats() for pool in pools]
    return {key: sum(s.get(key, 0) for s in stats) for key in keys}


def failure_details(error):
    """Diagnóstico público sem incorporar a mensagem original ou credenciais."""
    name = type(error).__name__
    if name == "PoolTimeout":
        return "DB_POOL_TIMEOUT", "O servidor não conseguiu obter uma conexão com o banco no prazo.", True
    if name == "TooManyRequests":
        return "DB_BUSY", "Há muitas requisições aguardando o banco.", True
    if name == "LockNotAvailable":
        return "DB_LOCK", "Uma operação está bloqueando o acesso aos dados.", False
    if name == "QueryCanceled":
        return "DB_QUERY_TIMEOUT", "A consulta ao banco excedeu o prazo.", False
    text = str(error).lower()
    state = getattr(error, "sqlstate", None)
    if state == "28P01" or "password authentication failed" in text:
        return "DB_AUTH", "O banco recusou a autenticação. Confira a DATABASE_URL no Render.", False
    if any(value in text for value in ("failed to resolve", "could not translate host", "getaddrinfo")):
        return "DB_DNS", "O servidor não conseguiu localizar o endereço do banco.", False
    if any(value in text for value in ("certificate", "ssl", "tls", "channel binding")):
        return "DB_TLS", "Não foi possível estabelecer a conexão segura com o banco.", False
    if "timeout" in text or "timed out" in text:
        return "DB_CONNECT_TIMEOUT", "O banco não respondeu à tentativa de conexão no prazo.", True
    return "DB_CONNECTION", "A conexão com o banco foi interrompida ou não pôde ser estabelecida.", True


def translate(sql):
    """Converte somente os padrões SQL usados pelo projeto; preserva literais."""
    parts = re.split(r"('(?:[^']|'')*')", sql)
    for i in range(0, len(parts), 2):
        text = parts[i]
        text = re.sub(r"INTEGER PRIMARY KEY(?: AUTOINCREMENT)?", "BIGSERIAL PRIMARY KEY", text, flags=re.I)
        text = re.sub(r"([\w.]+) COLLATE NOCASE", r"lower(\1)", text, flags=re.I)
        text = re.sub(r'(?<!["\w])user(?!["\w])', '"user"', text, flags=re.I)
        text = re.sub(r"SUM\((\w+\.\w+)\s*=\s*(\d+)\)", r"SUM(CASE WHEN \1=\2 THEN 1 ELSE 0 END)", text, flags=re.I)
        text = re.sub(r"julianday\(([\w.]+)\)", r"(EXTRACT(EPOCH FROM (\1)::timestamptz) / 86400.0)", text, flags=re.I)
        parts[i] = text
    sql = "".join(parts)
    insert = re.match(r"\s*INSERT INTO (\w+)\b", sql, re.I)
    returning = bool(insert and insert[1].lower() in ID_TABLES and not re.search(r"\bRETURNING\b", sql, re.I))
    if returning:
        sql = sql.rstrip().rstrip(";") + " RETURNING id"
    return sql, returning


def placeholders(sql):
    parts = re.split(r"('(?:[^']|'')*')", sql.replace("%", "%%"))
    for i in range(0, len(parts), 2):
        parts[i] = parts[i].replace("?", "%s")
    return "".join(parts)


class Row:
    def __init__(self, columns, values):
        self.columns = columns
        self.values = tuple(float(v) if isinstance(v, Decimal) else v for v in values)
        self.positions = {name: i for i, name in enumerate(columns)}

    def keys(self):
        return self.columns

    def __getitem__(self, key):
        return self.values[self.positions[key]] if isinstance(key, str) else self.values[key]

    def __iter__(self):
        return iter(self.values)


class Result:
    def __init__(self, rows=(), rowcount=0, lastrowid=None):
        self.rows = iter(rows)
        self.rowcount, self.lastrowid = rowcount, lastrowid

    def fetchone(self):
        return next(self.rows, None)

    def fetchall(self):
        return list(self.rows)

    def __iter__(self):
        return self.rows


class PostgresConnection:
    def __init__(self, raw, pool):
        self.raw, self.pool = raw, pool
        self.closed = False
        self.query_count = 0
        self.query_seconds = 0.0

    def ensure_transaction(self):
        from psycopg.pq import TransactionStatus
        if self.raw.info.transaction_status == TransactionStatus.IDLE:
            self.raw.execute("SELECT set_config('statement_timeout','20s',true), set_config('lock_timeout','5s',true)")

    def execute(self, sql, params=()):
        self.query_count += 1
        start = time.perf_counter()
        try:
            self.ensure_transaction()
            if sql.strip().upper().startswith("PRAGMA"):
                match = re.search(r"table_info\((\w+)\)", sql, re.I)
                if not match:
                    return Result()
                cur = self.raw.execute("SELECT ordinal_position-1,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=%s ORDER BY ordinal_position", (match[1],))
                return Result([Row(["cid", "name"], r) for r in cur.fetchall()])
            sql, returning = translate(sql)
            cur = self.raw.execute(placeholders(sql), tuple(params))
            if returning:
                value = cur.fetchone()
                return Result(rowcount=cur.rowcount, lastrowid=value[0] if value else None)
            columns = [d.name for d in cur.description] if cur.description else []
            rows = [Row(columns, r) for r in cur.fetchall()] if columns else []
            return Result(rows, rowcount=cur.rowcount)
        except Exception as exc:
            # Existing validation handles the same integrity error in both engines.
            from psycopg import IntegrityError
            if isinstance(exc, IntegrityError):
                raise sqlite3.IntegrityError("violação de integridade") from exc
            raise
        finally:
            self.query_seconds += time.perf_counter() - start

    def executemany(self, sql, rows):
        rows = list(rows)
        if not rows:
            return Result()
        sql, returning = translate(sql)
        if returning:
            sql = sql.removesuffix(" RETURNING id")
        start = time.perf_counter()
        self.query_count += 1
        try:
            self.ensure_transaction()
            with self.raw.cursor() as cur:
                cur.executemany(placeholders(sql), rows)
                return Result(rowcount=cur.rowcount)
        finally:
            self.query_seconds += time.perf_counter() - start

    def executescript(self, script):
        for sql in script.split(";"):
            if sql.strip():
                self.execute(sql)

    def commit(self):
        self.raw.commit()

    def rollback(self):
        self.raw.rollback()

    def close(self):
        if not self.closed:
            self.closed = True
            try:
                self.raw.rollback()
            finally:
                self.pool.putconn(self.raw)


def connect(path):
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        conn = sqlite3.connect(path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn
    if not url.startswith(("postgresql://", "postgres://")):
        raise RuntimeError("DATABASE_URL precisa ser uma URL PostgreSQL.")
    from psycopg_pool import NullConnectionPool
    with _pool_lock:
        if url not in _pools:
            # Neon já usa PgBouncer. Não manter outra fila de reconexões em
            # segundo plano: tentativas expiradas poderiam saturar max_waiting.
            # NullConnectionPool conecta na requisição, limita a concorrência e
            # fecha/devolve a conexão ao término, sem crescer um pool ocioso.
            _pools[url] = NullConnectionPool(url, max_size=4, timeout=20,
                max_waiting=12, kwargs={"connect_timeout": 10, "prepare_threshold": None}, open=True)
        pool = _pools[url]
    return PostgresConnection(pool.getconn(), pool)


def insert_many(conn, sql, rows):
    """Retorna IDs na ordem de entrada, sem uma viagem à rede por registro."""
    if not rows:
        return []
    if not isinstance(conn, PostgresConnection):
        return [conn.execute(sql, row).lastrowid for row in rows]
    sql, _ = translate(sql)
    ids = []
    start = time.perf_counter()
    conn.query_count += 1
    try:
        conn.ensure_transaction()
        with conn.raw.cursor() as cur:
            cur.executemany(placeholders(sql), rows, returning=True)
            while True:
                ids.append(cur.fetchone()[0])
                if not cur.nextset():
                    break
        return ids
    finally:
        conn.query_seconds += time.perf_counter() - start
