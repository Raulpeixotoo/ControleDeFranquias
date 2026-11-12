"""Leitura da planilha de unidades (varias abas) e comparacao com o que ja esta no banco.

Chave de cada unidade: a SIGLA (ex.: CO-RBR-01). Sem sigla, usa TIPO#PONTO.
O tipo vem do prefixo da sigla (CO, LJ, PA, FL, HB, JE, ...); qualquer prefixo novo entra sozinho.
"""
import datetime as dt
import json
import re
import unicodedata
import database

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

ALIASES = {
    "uf": ["uf"], "sigla": ["sigla"], "nickname": ["nickname"],
    "aeroporto": ["aeroporto", "iata"], "ponto": ["ponto"], "desde": ["desde", "inauguracao"],
    "cnpj": ["cnpj"], "razao_social": ["razao social"], "endereco": ["endereco"], "bairro": ["bairro"],
    "cidade": ["cidade"], "cep": ["cep"],
    "telefone": ["telefone fixo", "telefones fixo", "telefones", "telefone"],
    "celular": ["celulares gestores publico"],
    "email": ["e mail oficial"], "email_gestor": ["e mail gestor"],
    "franqueado": ["franqueado", "gerente", "parceiro operacional"],
    "equipe": ["equipe"], "consultor": ["consultor de campo"],
    "funcionamento": ["funcionamento", "funcionamento ao publico"],
    "visitada": ["visitada"], "triagem": ["triagem"],
    "unidade_master": ["franquia master"],          # JE: unidade responsavel (ex.: CO ATIBAIA 01)
}
REV = {h: f for f, hs in ALIASES.items() for h in hs}

# campos comparados entre uma planilha e a outra (alem de "extra" e da situacao)
TRACK = ["sigla", "tipo", "nome", "uf", "cidade", "ponto", "aeroporto", "desde", "cnpj", "razao_social",
         "endereco", "bairro", "cep", "telefone", "celular", "email", "email_gestor", "franqueado", "unidade_master",
         "equipe", "consultor", "funcionamento", "visitada", "triagem"]

INSERT_COLS = ["chave", "sigla", "tipo", "nome", "uf", "cidade", "responsavel", "situacao", "sit_planilha",
               "ponto", "aeroporto", "desde", "cnpj", "razao_social", "endereco", "bairro", "cep", "telefone",
               "celular", "email", "email_gestor", "franqueado", "unidade_master", "equipe", "consultor", "funcionamento",
               "visitada", "triagem", "extra", "origem", "created_at", "updated_at", "updated_by"]


def nh(s):
    s = unicodedata.normalize("NFD", str(s)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def ns(v):
    return "" if v is None else re.sub(r"\s+", " ", str(v)).strip()


def clean_val(v):
    if v is None:
        return ""
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    s = ns(v)
    return "" if s in ("-", "--", "N/A", "n/a") else s


def field_for(header):
    k = nh(header)
    if k.startswith("je s fechados"):
        return "nickname"
    return REV.get(k)


def cnpj_ok(d):
    if len(d) != 14 or d == d[0] * 14:
        return False

    def dv(base, pesos):
        s = sum(int(a) * b for a, b in zip(base, pesos))
        r = s % 11
        return "0" if r < 2 else str(11 - r)
    d1 = dv(d[:12], [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
    d2 = dv(d[:12] + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
    return d[12:] == d1 + d2


def norm_cnpj(raw):
    """-> (texto, valido?). Vazio e considerado valido (nao alerta)."""
    if isinstance(raw, str):
        raw = clean_val(raw)
    if raw in (None, ""):
        return "", True
    is_num = isinstance(raw, (int, float))
    s = str(int(raw)) if is_num and float(raw).is_integer() else str(raw)
    d = re.sub(r"\D", "", s)
    if is_num and len(d) in (12, 13):
        d = d.zfill(14)
    if len(d) == 14:
        return f"{d[:2]}.{d[2:5]}.{d[5:8]}/{d[8:12]}-{d[12:]}", cnpj_ok(d)
    return s.strip(), False


def sheet_tipo(title):
    m = re.match(r"\s*([A-Za-z]{2,3})", title)
    t = (m.group(1) if m else title).upper()
    return t[:-1] if len(t) == 3 and t.endswith("S") else t


# ------------------------------------------------------------------ leitura
def parse_workbook(path, ufs):
    wb = load_workbook(path, read_only=True, data_only=True)
    try:
        return _parse(wb, ufs)
    finally:
        wb.close()          # no Windows o arquivo fica preso se nao fechar


def _parse(wb, ufs):
    rows, errors, warnings, sheets = {}, [], [], {}
    bad_cnpj, bad_uf, dupes, pending, orphans = [], [], [], [], []
    for ws in wb.worksheets:
        it = ws.iter_rows(values_only=True)
        header = next(it, None)
        if not header:
            continue
        used, cols = set(), []
        extra_seen = set()
        for idx, h in enumerate(header, start=1):
            if h is None or ns(h) == "":
                name = f"Coluna {get_column_letter(idx)} (sem título)"     # guarda o que houver, mesmo sem cabecalho
                extra_seen.add(name)
                cols.append((None, name))
                continue
            f = field_for(h)
            if f and f not in used:
                used.add(f)
                cols.append((f, None))
            else:
                name, i = ns(h), 2
                while name in extra_seen:
                    name = f"{ns(h)} ({i})"
                    i += 1
                extra_seen.add(name)
                cols.append((None, name))
        if "sigla" not in used and "nickname" not in used:
            warnings.append(f'Aba "{ws.title}" ignorada: não tem coluna SIGLA nem NICKNAME.')
            continue
        tipo_aba, fechada, n = sheet_tipo(ws.title), "FECHAD" in ws.title.upper(), 0
        for rn, r in enumerate(it, start=2):
            rec, extra, raw_cnpj, raw_ponto = {}, {}, None, None
            for (f, xname), v in zip(cols, r):
                if f == "cnpj":
                    raw_cnpj = v
                elif f == "ponto":
                    raw_ponto = v
                elif f:
                    rec[f] = clean_val(v)
                elif xname:
                    cv = clean_val(v)
                    if cv:
                        extra[xname] = cv
            rec["ponto"] = clean_val(raw_ponto)
            rec["cnpj"], ok = norm_cnpj(raw_cnpj)
            if not any([rec.get("sigla"), rec.get("nickname"), rec.get("razao_social"), rec["cnpj"], rec["ponto"]]):
                if any(v for k, v in rec.items() if k not in ("cnpj", "ponto")) or extra:     # tem dado solto, mas nao e uma unidade
                    orphans.append(f"{ws.title.split()[0]} linha {rn}")
                continue                                    # senao: linha em branco
            sigla = re.sub(r"\s+", "", rec.get("sigla", "")).upper()
            uf = rec.get("uf", "").upper()[:2]
            nome = rec.get("nickname") or rec.get("razao_social") or sigla or (f"Ponto {rec['ponto']}" if rec["ponto"] else rec["cnpj"])
            if not nome:
                errors.append(f"{ws.title}, linha {rn}: sem nome, sigla, ponto ou CNPJ — ignorada")
                continue
            if uf not in ufs:                      # mantem a unidade; so avisa para corrigir a UF
                bad_uf.append(f'{nome} ({ws.title}, linha {rn}: "{uf or "vazia"}")')
                uf = ""
            m = re.match(r"^([A-Z]{2,3})-", sigla)
            tipo = m.group(1) if m else tipo_aba
            row = dict(rec, uf=uf, sigla=sigla, tipo=tipo, extra=extra, aba=ws.title, nome=nome,
                       situacao="fechada" if fechada else "ativa")
            for f in TRACK:
                row.setdefault(f, "")
            if not ok:
                bad_cnpj.append(sigla or row["nome"])
            pending.append(row)
            sheets[ws.title] = sheets.get(ws.title, 0) + 1
    # SIGLA e PONTO sozinhos se repetem (ex.: HB-MAO-01 existe duas vezes com CNPJs e parceiros diferentes).
    # Chave = SIGLA|PONTO; se colidir, soma o nome; se colidir de novo, soma o CNPJ; so entao #2, #3 (nenhuma linha e descartada).
    def base(r):
        if r["sigla"] and r["ponto"]:
            return f"{r['sigla']}|{r['ponto']}"
        return r["sigla"] or (f"{r['tipo']}#{r['ponto']}" if r["ponto"] else f"{r['tipo']}#{nh(r['nome'])}")
    keys = [base(r) for r in pending]
    for step in range(2):
        cnt = {}
        for k in keys:
            cnt[k] = cnt.get(k, 0) + 1
        keys = [k if cnt[k] == 1 else (f"{k}|{nh(r['nome'])}" if step == 0 else f"{k}|{re.sub(r'[^0-9]', '', r['cnpj'])}")
                for k, r in zip(keys, pending)]
    seen = {}
    for k, r in zip(keys, pending):
        seen[k] = seen.get(k, 0) + 1
        ch = k if seen[k] == 1 else f"{k}#{seen[k]}"
        if seen[k] > 1:
            dupes.append(f"{r['nome']} ({r['aba']})")
        rows[ch] = dict(r, chave=ch)
    if bad_cnpj:
        warnings.append(f'{len(bad_cnpj)} CNPJ(s) com formato/dígito inválido, ex.: ' + ", ".join(bad_cnpj[:6]))
    if orphans:
        warnings.append(f"{len(orphans)} linha(s) com dados soltos, sem nome/sigla/ponto/CNPJ (parecem linhas desalinhadas no Excel; "
                        "NÃO viraram unidade — confira): " + ", ".join(orphans[:12]) + ("…" if len(orphans) > 12 else ""))
    if bad_uf:
        warnings.append(f'{len(bad_uf)} unidade(s) com UF vazia/inválida foram importadas SEM UF (corrija no Excel): ' + "; ".join(bad_uf[:5]))
    if dupes:
        warnings.append(f'{len(dupes)} registro(s) com mesma sigla, ponto, nome e CNPJ, mas dados diferentes (franqueado, telefone…), mantidos separados: ' + "; ".join(dupes[:5]))
    return dict(rows=rows, errors=errors, warnings=warnings, sheets=sheets)


# ------------------------------------------------------------------ comparacao
def diff_unit(old, new):
    d = {}
    for f in TRACK:
        a, b = ns(old.get(f)), ns(new.get(f))
        if a != b:
            d[f] = [a[:150], b[:150]]
    try:
        oe = json.loads(old.get("extra") or "{}")
    except ValueError:
        oe = {}
    for k in set(oe) | set(new["extra"]):
        a, b = ns(oe.get(k)), ns(new["extra"].get(k))
        if a != b:
            d["extra:" + k] = [a[:150], b[:150]]
    if new["situacao"] != ns(old.get("sit_planilha")):
        d["situacao"] = [ns(old.get("sit_planilha")), new["situacao"]]
    return d


def plan_import(conn, rows):
    old = {r["chave"]: dict(r) for r in conn.execute("SELECT * FROM units WHERE origem='planilha'")}
    matched = {ch: old[ch] for ch in rows if ch in old}
    new_keys = [ch for ch in rows if ch not in matched]
    gone = {ch: o for ch, o in old.items() if ch not in rows}
    # mesma unidade com a chave alterada: tenta casar pelo PONTO (sigla mudou) e depois pela SIGLA (ponto mudou),
    # so quando ha exatamente um candidato de cada lado, para nao juntar unidades diferentes
    for field in ("ponto", "sigla"):
        idx = {}
        for ch, o in gone.items():
            if o.get(field):
                idx.setdefault((o[field], o["tipo"]), []).append(ch)
        cnt = {}
        for ch in new_keys:
            if rows[ch][field]:
                k = (rows[ch][field], rows[ch]["tipo"])
                cnt[k] = cnt.get(k, 0) + 1
        for ch in list(new_keys):
            k = (rows[ch][field], rows[ch]["tipo"])
            if rows[ch][field] and cnt[k] == 1 and len(idx.get(k, [])) == 1:
                matched[ch] = gone.pop(idx.pop(k)[0])
                new_keys.remove(ch)
    upd, unchanged = [], 0
    for ch, o in matched.items():
        d = diff_unit(o, rows[ch])
        back = bool(o.get("saiu_em"))
        if d or back or o["chave"] != ch:
            upd.append(dict(old=o, row=rows[ch], diff=d, back=back))
        else:
            unchanged += 1
    return dict(new=[rows[k] for k in new_keys], upd=upd,
                gone=[o for o in gone.values() if not o.get("saiu_em")], unchanged=unchanged)


def preview_changes(plan, limit=80):
    out = []
    for r in plan["gone"]:
        out.append(dict(kind="saiu", nome=r["nome"], chave=r["chave"], tipo=r["tipo"], diff={}))
    for u in plan["upd"]:
        out.append(dict(kind="reativada" if u["back"] else "alterada", nome=u["row"]["nome"],
                        chave=u["row"]["chave"], tipo=u["row"]["tipo"], diff=u["diff"]))
    for r in plan["new"]:
        out.append(dict(kind="nova", nome=r["nome"], chave=r["chave"], tipo=r["tipo"], diff={}))
    return out[:limit]


# ------------------------------------------------------------------ gravacao
def apply_plan(conn, plan, ref_month, filename, user, ts):
    cur = conn.execute(
        "INSERT INTO snapshots (ref_month, uploaded_at, uploaded_by, filename, total, novas, saidas, alteradas,"
        " reativadas, by_tipo, primeira) VALUES (?,?,?,?,0,?,?,?,?, '{}', ?)",
        (ref_month, ts, user, filename, len(plan["new"]), len(plan["gone"]),
         sum(1 for u in plan["upd"] if not u["back"]), sum(1 for u in plan["upd"] if u["back"]),
         0 if conn.execute("SELECT 1 FROM units WHERE origem='planilha' LIMIT 1").fetchone() else 1))
    sid = cur.lastrowid

    changes = []
    def change(uid, row, kind, diff):
        changes.append((sid, uid, row["chave"], row["nome"], row["tipo"], kind, json.dumps(diff, ensure_ascii=False)))

    new_values = []
    for r in plan["new"]:
        vals = dict(r, responsavel=r["franqueado"], sit_planilha=r["situacao"], origem="planilha",
                    extra=json.dumps(r["extra"], ensure_ascii=False), created_at=ts, updated_at=ts, updated_by=user)
        new_values.append([vals[k] for k in INSERT_COLS])
    new_ids = database.insert_many(conn, f"INSERT INTO units ({','.join(INSERT_COLS)}) VALUES ({','.join('?' * len(INSERT_COLS))})", new_values)
    for uid, r in zip(new_ids, plan["new"]):
        change(uid, r, "nova", {})
    for u in plan["upd"]:
        o, r, d = u["old"], u["row"], u["diff"]
        sets = {f: r[f] for f in TRACK if f in d}
        if "franqueado" in d:
            sets["responsavel"] = r["franqueado"]
        if "situacao" in d:
            sets["situacao"] = sets["sit_planilha"] = r["situacao"]
        sets.update(chave=r["chave"], extra=json.dumps(r["extra"], ensure_ascii=False), saiu_em=None,
                    updated_at=ts, updated_by=user)
        conn.execute(f"UPDATE units SET {','.join(k + '=?' for k in sets)} WHERE id=?", [*sets.values(), o["id"]])
        change(o["id"], r, "reativada" if u["back"] else "alterada", d)
    for o in plan["gone"]:
        conn.execute("UPDATE units SET saiu_em=?, updated_at=?, updated_by=? WHERE id=?", (ref_month, ts, user, o["id"]))
        change(o["id"], o, "saiu", {})

    conn.executemany("INSERT INTO unit_changes (snapshot_id, unit_id, chave, nome, tipo, kind, diff) VALUES (?,?,?,?,?,?,?)", changes)
    by = dict(conn.execute("SELECT tipo, COUNT(*) FROM units WHERE saiu_em IS NULL AND situacao NOT IN ('fechada','inativa')"
                           " GROUP BY tipo").fetchall())
    conn.execute("UPDATE snapshots SET total=?, by_tipo=? WHERE id=?", (sum(by.values()), json.dumps(by), sid))
    return dict(id=sid, total=sum(by.values()), by_tipo=by)
