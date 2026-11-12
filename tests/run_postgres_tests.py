"""Testes em bancos PostgreSQL descartáveis, sem tocar no banco do app.

Defina TEST_POSTGRES_URL com uma conexão que possa criar bancos de teste.
Não use DATABASE_URL de produção. Não requer git.
"""
import ast
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit, urlunsplit
import uuid

import psycopg
from psycopg import sql

ROOT = Path(__file__).resolve().parents[1]


def main():
    url = os.environ.get("TEST_POSTGRES_URL", "")
    if not url:
        print("Defina TEST_POSTGRES_URL para um servidor PostgreSQL de teste.")
        return 2
    jobs = [["discover", "-s", "tests", "-p", "test_api.py", "-v"]]
    tree = ast.parse((ROOT / "tests" / "test_masters.py").read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name.startswith("test_"):
            jobs.append(["test_masters.Masters." + node.name, "-v"])
    parsed = urlsplit(url)
    with psycopg.connect(url, autocommit=True) as admin:
        for job in jobs:
            name = "controle_test_" + uuid.uuid4().hex[:12]
            admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
            env = dict(os.environ, DATABASE_URL=urlunsplit(parsed._replace(path="/" + name)),
                       PYTHONPATH=str(ROOT) + os.pathsep + str(ROOT / "tests"))
            env.pop("RENDER", None)
            env.pop("ACCESS_CODE", None)
            try:
                result = subprocess.run([sys.executable, "-m", "unittest", *job], cwd=ROOT, env=env)
            finally:
                admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
            if result.returncode:
                return result.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
