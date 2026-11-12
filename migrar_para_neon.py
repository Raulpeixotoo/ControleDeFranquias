"""Copia SQLite para um PostgreSQL de teste vazio, preservando IDs e vínculos.

Execute localmente: python migrar_para_neon.py
A URL é solicitada sem eco e nunca é salva no projeto.
"""
import argparse
import getpass
import os
from pathlib import Path
import sqlite3
import tempfile
from urllib.parse import urlsplit

TABLES = ("units", "incidents", "log", "snapshots", "unit_changes", "pipe_fases", "pipe_tipos",
          "pipe_campos", "aberturas", "abertura_valores", "settings", "sol_categorias",
          "sol_subcategorias", "sol_etapas", "solicitacoes", "sol_hist", "master_users")
BUSINESS_TABLES = ("units", "incidents", "log", "snapshots", "aberturas", "solicitacoes", "master_users")


def transfer(source, target):
    """Destino deve ter o esquema criado pelo app; qualquer dado real bloqueia a cópia."""
    from psycopg import sql
    counts = {}
    with target.transaction():
        target.execute("SELECT pg_advisory_xact_lock(19482631)")
        for table in BUSINESS_TABLES:
            if target.execute(sql.SQL("SELECT 1 FROM {} LIMIT 1").format(sql.Identifier(table))).fetchone():
                raise ValueError("O destino já contém dados. Use um banco/branch de teste vazio para evitar sobrescrever registros.")
        if target.execute("SELECT 1 FROM settings WHERE chave='sqlite_migrated'").fetchone():
            raise ValueError("Este banco já recebeu uma migração.")
        names = sql.SQL(",").join(sql.Identifier(table) for table in TABLES)
        target.execute(sql.SQL("TRUNCATE {} RESTART IDENTITY CASCADE").format(names))
        for table in TABLES:
            columns = [r[1] for r in source.execute(f'PRAGMA table_info("{table}")')]
            if not columns:
                raise ValueError(f"Tabela {table} ausente no SQLite. Atualize o app local antes de migrar.")
            rows = source.execute(f'SELECT * FROM "{table}"')
            query = sql.SQL("COPY {} ({}) FROM STDIN").format(sql.Identifier(table), sql.SQL(",").join(map(sql.Identifier, columns)))
            count = 0
            with target.cursor().copy(query) as copy:
                for row in rows:
                    copy.write_row(tuple(row))
                    count += 1
            actual = target.execute(sql.SQL("SELECT COUNT(*) FROM {}").format(sql.Identifier(table))).fetchone()[0]
            if actual != count:
                raise ValueError(f"Contagem divergente em {table}; migração cancelada.")
            counts[table] = count
            if "id" in columns:
                seq = target.execute("SELECT pg_get_serial_sequence(%s,'id')", (table,)).fetchone()[0]
                if seq:
                    target.execute(sql.SQL("SELECT setval(%s::regclass,COALESCE((SELECT MAX(id) FROM {}),1),EXISTS(SELECT 1 FROM {}))").format(sql.Identifier(table), sql.Identifier(table)), (seq,))
        target.execute("INSERT INTO settings(chave,valor) VALUES ('cloud_schema_version','1') ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor")
        target.execute("INSERT INTO settings(chave,valor) VALUES ('sqlite_migrated','1')")
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", default=str(Path(__file__).with_name("franquias.db")))
    args = parser.parse_args()
    path = Path(args.sqlite).resolve()
    if not path.is_file():
        raise ValueError("Banco SQLite não encontrado.")
    url = os.environ.get("DATABASE_URL", "").strip() or getpass.getpass("Cole a URL PostgreSQL do banco de TESTE no Neon (não aparece ao digitar): ").strip()
    parsed = urlsplit(url)
    if parsed.scheme not in ("postgres", "postgresql") or not parsed.hostname:
        raise ValueError("URL PostgreSQL inválida.")
    print("A cópia inclui unidades, solicitações, usuários, pipeline e configurações.")
    print("O banco local não será alterado. O destino precisa estar vazio.")
    if input("Digite MIGRAR para enviar os dados ao banco de teste: ").strip() != "MIGRAR":
        print("Cancelado.")
        return
    os.environ["DATABASE_URL"] = url
    import app  # cria somente o esquema e as configurações iniciais do destino
    import psycopg
    with tempfile.TemporaryDirectory(prefix="migracao-neon-") as tmp:
        snapshot = Path(tmp) / "snapshot.db"
        original = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
        local = sqlite3.connect(snapshot)
        try:
            original.backup(local)
            if local.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Falha de integridade no SQLite.")
            with psycopg.connect(url, prepare_threshold=None, connect_timeout=10) as target:
                counts = transfer(local, target)
        finally:
            original.close()
            local.close()
    print("Migração concluída e contagens verificadas:")
    for table, count in counts.items():
        print(f"  {table}: {count}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Não imprimir URLs/credenciais em erros de conexão.
        if isinstance(exc, ValueError):
            print("Não foi possível migrar:", exc)
        else:
            print("Não foi possível migrar (" + type(exc).__name__ + "). Confira a conexão e use um banco de teste vazio.")
        raise SystemExit(1)
