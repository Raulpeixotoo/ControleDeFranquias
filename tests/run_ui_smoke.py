"""Sobe o servidor com um banco temporário (já populado), roda o smoke de navegador e encerra o servidor.
Uso:  python tests/run_ui_smoke.py [pasta-de-screenshots]      (requer Node 22+ e Chrome/Edge instalados)"""
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests"))
tmp = tempfile.mkdtemp()
os.environ["FRANQUIAS_DB"] = os.path.join(tmp, "smoke.db")

import app  # noqa: E402
import fixtures  # noqa: E402

fixtures.seed(app.app.test_client())

with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
server = subprocess.Popen([sys.executable, os.path.join(ROOT, "app.py")], cwd=ROOT, env={**os.environ, "PORT": str(port)},
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=1)
            break
        except OSError:
            time.sleep(0.25)
    units_xlsx, abertura_xlsx = os.path.join(tmp, "unidades.xlsx"), os.path.join(tmp, "abertura.xlsx")
    for path, wb in ((units_xlsx, fixtures.units_workbook()), (abertura_xlsx, fixtures.abertura_workbook())):
        with open(path, "wb") as f:
            f.write(wb.getvalue())
    shots = sys.argv[1] if len(sys.argv) > 1 else "-"
    code = subprocess.call(["node", os.path.join(ROOT, "tests", "ui_smoke.mjs"), f"http://127.0.0.1:{port}/", shots, units_xlsx, abertura_xlsx])
finally:
    server.terminate()
    server.wait(timeout=10)
sys.exit(code)
