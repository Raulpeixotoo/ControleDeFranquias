"""Pipeline de abertura de franquias (aba start_NN da planilha "abertura de unidades").

Estrutura da aba:  linha 1 = FASES, linha 2 = TIPOS (grupos de colunas), linha 3 = CAMPOS, linhas 4+ = candidatos.
Tudo e lido pelo TEXTO do cabecalho (nao pela letra da coluna), entao inserir/remover colunas nao quebra.

Atualizacao mensal: cada celula guarda tambem o ultimo valor IMPORTADO (coluna imp). Se a planilha nova traz o mesmo
valor de antes, o que foi editado no site e mantido; se a planilha mudou aquela celula, a planilha vence.
"""
import datetime as dt
import json
import re

from openpyxl import load_workbook

import database

from importer import nh, ns

STATUS_WORDS = {"ok", "-", "--", "n/a", "na", "n", "s", "same", "andamento", "negado", "nao", "sim", "isento"}
IDENT = {"uf": "uf", "localidade unidade master": "nome", "start process": "start", "previsao go live": "golive",
         "candidato": "candidato", "celular whats": "celular"}
PAPEL_KIND = {"start": "data", "golive": "texto", "candidato": "texto", "celular": "texto"}


def pretty(s):
    """'F A S E  I NI C I A L   0 1' -> 'Fase Inicial 01'; texto normal fica como esta (so ajusta caixa alta)."""
    s = str(s or "").replace("\xa0", " ").strip()
    toks = s.split()
    if len(toks) >= 4 and sum(len(t) <= 2 for t in toks) / len(toks) > 0.6:
        s = " ".join(p.replace(" ", "") for p in re.split(r"\s{2,}", s))
    s = re.sub(r"\s+", " ", s).strip()
    return s.title() if s.isupper() else s


def raw_value(v):
    if v is None:
        return ""
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return ns(v)


def guess_kind(values):
    vals = [v for v in values if v not in ("", "-")]
    if not vals:
        return "status"
    dates = sum(bool(re.match(r"^\d{4}-\d{2}-\d{2}$|^\d{2}/\d{2}/\d{4}$", v)) for v in vals)
    stat = sum(v.lower() in STATUS_WORDS for v in vals)
    if dates / len(vals) >= 0.5:
        return "data"
    if (stat + dates) / len(vals) >= 0.5:
        return "status"
    return "texto"


def _fill(cell):
    f = cell.fill
    if f and f.fill_type:
        c = f.fgColor
        return c.rgb if c.type == "rgb" else f"t{c.theme}"
    return None


def _type_spans(ws, labels2, merged, c_first, c_last):
    """Para cada rotulo da linha 2, o intervalo de colunas que ele cobre (mesclagem > cor de fundo > so a celula)."""
    spans = {}
    for col in labels2:
        span = None
        for m in merged:
            if m.min_row <= 2 <= m.max_row and m.min_col <= col <= m.max_col:
                span = (m.min_col, m.max_col)
        if span is None and _fill(ws.cell(2, col)):
            fl, a, b = _fill(ws.cell(2, col)), col, col
            while a - 1 >= c_first and _fill(ws.cell(2, a - 1)) == fl and (a - 1) not in labels2:
                a -= 1
            while b + 1 <= c_last and _fill(ws.cell(2, b + 1)) == fl and (b + 1) not in labels2:
                b += 1
            span = (a, b)
        spans[col] = span or (col, col)
    return spans


def parse_start(path, sheet, ufs):
    wb = load_workbook(path, data_only=True)
    try:
        names = wb.sheetnames
        ws = next((wb[n] for n in names if nh(n) == nh(sheet)), None)
        if ws is None:
            raise ValueError(f'não achei a aba "{sheet}". Abas do arquivo: ' + ", ".join(names))
        last = max((c.column for c in ws[3] if ns(c.value)), default=0)
        if last == 0:
            raise ValueError("a linha 3 (nomes das colunas) está vazia")
        merged = list(ws.merged_cells.ranges)
        # fases: rotulo da linha 1 vale da celula do rotulo ate antes do proximo rotulo
        ph_cols = sorted(c for c in range(1, last + 1) if ns(ws.cell(1, c).value))
        if not ph_cols:
            raise ValueError("a linha 1 (fases) está vazia")
        first_phase = ph_cols[0]
        phase_of = {}
        for i, pc in enumerate(ph_cols):
            end = (ph_cols[i + 1] - 1) if i + 1 < len(ph_cols) else last
            for c in range(pc, end + 1):
                phase_of[c] = (i, pretty(ws.cell(1, pc).value))
        labels2 = {c: pretty(ws.cell(2, c).value) for c in range(first_phase, last + 1) if ns(ws.cell(2, c).value)}
        spans = _type_spans(ws, labels2, merged, first_phase, last)
        type_of = {}
        for col in sorted(labels2, key=lambda x: spans[x][1] - spans[x][0], reverse=True):   # menores por ultimo = vencem
            ph = phase_of.get(col)
            for c in range(spans[col][0], spans[col][1] + 1):
                if c in phase_of and (ph is None or phase_of[c][0] == ph[0]):      # tipo nao atravessa fase
                    type_of[c] = labels2[col]

        campos, seen, uf_col, nome_col = [], {}, None, None
        for c in range(1, last + 1):
            label = ns(ws.cell(3, c).value)
            if not label:
                continue
            key = IDENT.get(nh(label))
            if key == "uf":
                uf_col = c
                continue
            if key == "nome":
                nome_col = c
                continue
            chave = nh(label)
            seen[chave] = seen.get(chave, 0) + 1
            if seen[chave] > 1:
                chave += f"#{seen[chave]}"
            campos.append(dict(col=c, chave=chave, label=label, papel=key,
                               fase=phase_of[c][1] if c in phase_of else None,
                               tipo=type_of.get(c) if c in phase_of else None))
        if uf_col is None or nome_col is None:
            raise ValueError('não achei as colunas "uf" e "LOCALIDADE/UNIDADE" na linha 3')

        rows, errors, keys = [], [], {}
        for r in range(4, ws.max_row + 1):
            nome = ns(ws.cell(r, nome_col).value)
            if not nome:
                continue
            uf = ns(ws.cell(r, uf_col).value).upper()[:2]
            if uf not in ufs:
                errors.append(f'linha {r} ({nome}): UF inválida "{uf}"')
                continue
            chave = f"{uf}|{nh(nome)}"
            keys[chave] = keys.get(chave, 0) + 1
            if keys[chave] > 1:
                chave += f"#{keys[chave]}"
            rows.append(dict(chave=chave, uf=uf, nome=nome,
                             v={cp["chave"]: raw_value(ws.cell(r, cp["col"]).value) for cp in campos}))
        for cp in campos:
            cp["kind"] = PAPEL_KIND.get(cp["papel"]) or guess_kind([row["v"][cp["chave"]] for row in rows])
    finally:
        wb.close()
    return dict(campos=campos, rows=rows, errors=errors, sheet=ws.title,
                fases=[p for _, p in sorted({v for v in phase_of.values()})])


# ------------------------------------------------------------------ comparacao / gravacao
def plan(conn, parsed):
    c_by_key = {r["chave"]: dict(r) for r in conn.execute("SELECT * FROM pipe_campos")}
    camp_label = {k: v["label"] for k, v in c_by_key.items()}
    new_campos = [cp for cp in parsed["campos"] if cp["chave"] not in c_by_key]
    existing = {r["chave"]: dict(r) for r in conn.execute("SELECT * FROM aberturas")}
    vals = {}
    for r in conn.execute("SELECT abertura_id, campo_id, valor, imp FROM abertura_valores"):
        vals[(r["abertura_id"], r["campo_id"])] = dict(r)
    key_id = {k: v["id"] for k, v in c_by_key.items()}
    out = dict(novas=[], voltaram=[], saiu=[], mudancas=[], novos_campos=new_campos, mudados=0)
    sheet_keys = {r["chave"] for r in parsed["rows"]}
    for row in parsed["rows"]:
        ab = existing.get(row["chave"])
        if not ab:
            out["novas"].append(row)
            continue
        if ab["saiu_em"]:
            out["voltaram"].append(row)
        changes = []
        for ck, new in row["v"].items():
            cid = key_id.get(ck)
            cur = vals.get((ab["id"], cid)) if cid else None
            if cur is None:
                if new != "":
                    changes.append((ck, "", new))
            elif new != (cur["imp"] if cur["imp"] is not None else ""):
                if new != cur["valor"]:
                    changes.append((ck, cur["valor"], new))
        if changes:
            out["mudancas"].append(dict(row=row, ab=ab, changes=changes))
            out["mudados"] += len(changes)
    out["saiu"] = [ab for k, ab in existing.items() if k not in sheet_keys and not ab["saiu_em"] and ab["origem"] == "planilha"]
    out["camp_label"] = camp_label
    out["n_existing"] = sum(1 for a in existing.values() if a["origem"] == "planilha" and not a["saiu_em"])
    return out


def preview(pl, parsed, limit=70):
    label = {cp["chave"]: cp["label"] for cp in parsed["campos"]}
    lines = []
    for n in pl["novas"]:
        lines.append(dict(kind="nova", nome=n["nome"], uf=n["uf"]))
    for a in pl["saiu"]:
        lines.append(dict(kind="saiu", nome=a["nome"], uf=a["uf"]))
    for m in pl["mudancas"]:
        lines.append(dict(kind="alterada", nome=m["row"]["nome"], uf=m["row"]["uf"],
                          diff={label.get(k, k): [o[:80], n[:80]] for k, o, n in m["changes"][:10]}, mais=max(0, len(m["changes"]) - 10)))
    return lines[:limit]


def _id_by_name(conn, table, nome, ts_order):
    if not nome:
        return None
    r = conn.execute(f"SELECT id FROM {table} WHERE lower(nome)=lower(?)", (nome,)).fetchone()
    if r:
        return r["id"]
    return conn.execute(f"INSERT INTO {table} (nome, ordem) VALUES (?,?)", (nome, ts_order)).lastrowid


def apply(conn, parsed, pl, user, ts):
    have = {r["chave"] for r in conn.execute("SELECT chave FROM pipe_campos")}
    groups = {table: {r["nome"]: r["id"] for r in conn.execute(f"SELECT id,nome FROM {table}")} for table in ("pipe_fases", "pipe_tipos")}
    orders = {table: conn.execute(f"SELECT COALESCE(MAX(ordem),0)+1 FROM {table}").fetchone()[0] for table in groups}
    def group_id(table, name):
        if not name:
            return None
        if name not in groups[table]:
            groups[table][name] = conn.execute(f"INSERT INTO {table} (nome,ordem) VALUES (?,?)", (name, orders[table])).lastrowid
            orders[table] += 1
        return groups[table][name]
    fields = []
    for cp in parsed["campos"]:
        if cp["chave"] not in have:
            fields.append((cp["chave"], cp["label"], group_id("pipe_fases", cp["fase"]), group_id("pipe_tipos", cp["tipo"]), cp["col"], cp["kind"], cp["papel"],
                           1 if cp["tipo"] and nh(cp["tipo"]).startswith("document") else 0))
    conn.executemany("INSERT INTO pipe_campos (chave,label,fase_id,tipo_id,ordem,kind,papel,pedir) VALUES (?,?,?,?,?,?,?,?)", fields)
    key_id = {r["chave"]: r["id"] for r in conn.execute("SELECT id,chave FROM pipe_campos")}
    current = {(r["abertura_id"], r["campo_id"]): dict(r) for r in conn.execute("SELECT abertura_id,campo_id,valor,imp FROM abertura_valores")}
    by_key = {r["chave"]: r["id"] for r in conn.execute("SELECT id,chave FROM aberturas")}
    inserts, imports, edits, missing_imports = [], [], [], []
    def write(abid, row):
        for ck, new in row["v"].items():
            cid = key_id[ck]
            cur = current.get((abid, cid))
            if cur is None:
                if new != "":
                    inserts.append((abid,cid,new,new,ts,user))
            else:
                imports.append((new,abid,cid))
                if new != (cur["imp"] if cur["imp"] is not None else "") and new != cur["valor"]:
                    edits.append((new,ts,user,abid,cid))
    new_ids = database.insert_many(conn,
        "INSERT INTO aberturas (chave,uf,nome,origem,created_at,updated_at,updated_by,last_change_at) VALUES (?,?,?,'planilha',?,?,?,?)",
        [(r["chave"],r["uf"],r["nome"],ts,ts,user,ts) for r in pl["novas"]])
    for abid, row in zip(new_ids, pl["novas"]):
        by_key[row["chave"]] = abid
        write(abid,row)
    for m in pl["mudancas"]:
        write(m["ab"]["id"],m["row"])
    for row in parsed["rows"]:
        abid = by_key.get(row["chave"])
        if abid:
            for ck,new in row["v"].items():
                cur = current.get((abid,key_id[ck]))
                if cur is not None and cur["imp"] is None:
                    missing_imports.append((new,abid,key_id[ck]))
    conn.executemany("INSERT INTO abertura_valores (abertura_id,campo_id,valor,imp,updated_at,updated_by) VALUES (?,?,?,?,?,?)",inserts)
    conn.executemany("UPDATE abertura_valores SET imp=? WHERE abertura_id=? AND campo_id=?",imports)
    conn.executemany("UPDATE abertura_valores SET valor=?,updated_at=?,updated_by=? WHERE abertura_id=? AND campo_id=?",edits)
    conn.executemany("UPDATE abertura_valores SET imp=? WHERE abertura_id=? AND campo_id=? AND imp IS NULL",missing_imports)
    conn.executemany("UPDATE aberturas SET last_change_at=?,updated_at=?,updated_by=?,saiu_em=NULL WHERE id=?",[(ts,ts,user,m["ab"]["id"]) for m in pl["mudancas"]])
    conn.executemany("UPDATE aberturas SET saiu_em=NULL,last_change_at=?,updated_at=? WHERE chave=?",[(ts,ts,r["chave"]) for r in pl["voltaram"]])
    conn.executemany("UPDATE aberturas SET saiu_em=?,updated_at=? WHERE id=?",[(ts[:10],ts,a["id"]) for a in pl["saiu"]])


# ------------------------------------------------------------------ estado para o front
def state(conn):
    campos = [dict(r) for r in conn.execute("SELECT id,chave,label,fase_id,tipo_id,ordem,kind,papel,pedir,nivel FROM pipe_campos ORDER BY ordem, id")]
    for c in campos:
        c["manual"] = c.pop("chave").startswith("manual:")
    abs_ = [dict(r, v={}) for r in conn.execute(
        "SELECT id,uf,nome,origem,saiu_em,created_at,last_change_at,prioridade,unidade_id FROM aberturas ORDER BY nome COLLATE NOCASE")]
    by_id = {a["id"]: a for a in abs_}
    for r in conn.execute("SELECT abertura_id, campo_id, valor FROM abertura_valores WHERE valor != ''"):
        a = by_id.get(r["abertura_id"])
        if a:
            a["v"][str(r["campo_id"])] = r["valor"]
    return dict(fases=[dict(r) for r in conn.execute("SELECT id,nome,ordem FROM pipe_fases ORDER BY ordem, id")],
                tipos=[dict(r) for r in conn.execute("SELECT id,nome,ordem FROM pipe_tipos ORDER BY ordem, id")],
                campos=campos, aberturas=abs_)
