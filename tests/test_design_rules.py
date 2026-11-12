"""Guarda das regras de design da interface (static/). Falha se alguém reintroduzir os padrões genéricos removidos na reformulação.
Rodar junto dos demais:  python -m unittest discover -s tests -v"""
import glob
import os
import re
import unittest

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")
READ = lambda p: open(os.path.join(STATIC, p), encoding="utf-8").read()
CSS = READ("style.css")
SOURCES = {f: READ(f) for f in ("index.html", "app.js", "pipeline.js", "pipegrid.js", "sol.js", "masters.js")}

# emoji e símbolos usados como ícone (a interface usa o sprite SVG de index.html). Setas e ✓ ✕ tipográficos são permitidos.
FORBIDDEN = set("⚙✉⚠⏱◈◐▦▤▥⇩⇪↺↗↳✎＋🎉🏢👤📋🚨🧭") | {chr(c) for c in range(0x1F300, 0x1FB00)}
# classes que só existem montadas em tempo de execução (sufixos dinâmicos) ou que são só ganchos de JS/teste
JS_HOOKS = {"over", "dragover", "dragging", "active", "editing", "hot", "warn", "bad", "red", "amb", "done", "has", "one", "wide", "id", "cur",
            "inativa", "clk", "sol", "cobrar", "sm", "danger", "ghost", "primary", "neutral", "sub", "mini", "d", "g", "r", "y"}


class RegrasDeDesign(unittest.TestCase):
    def test_sem_emoji_como_icone(self):
        for name, text in {**SOURCES, "style.css": CSS}.items():
            found = sorted({c for c in text if c in FORBIDDEN})
            self.assertEqual(found, [], f"{name}: use ic('nome') / o sprite SVG em vez de {found}")

    def test_texto_nunca_abaixo_de_13px(self):
        sizes = [float(x) for x in re.findall(r"font-size:\s*(\d+(?:\.\d+)?)px", CSS)]
        sizes += [float(x) for x in re.findall(r"--fs[\w-]*:\s*(\d+(?:\.\d+)?)px", CSS)]
        self.assertTrue(sizes)
        self.assertGreaterEqual(min(sizes), 13, "texto menor que 13px prejudica a leitura")

    def test_sombra_so_em_elevacao_real(self):
        for sel, body in re.findall(r"([^{}]+)\{([^{}]*)\}", re.sub(r"/\*.*?\*/", "", CSS, flags=re.S)):
            for value in re.findall(r"box-shadow:\s*([^;}]+)", body):
                v = value.strip()
                ok = "var(--elev)" in v or v.startswith("inset") or re.match(r"^-?\d+px 0 0 ", v)       # elevação, divisória fina ou marcador interno
                self.assertTrue(ok, f"sombra decorativa em '{sel.strip()}': {v}")

    def test_azul_padrao_removido(self):
        self.assertNotIn("#1f4fd8", CSS.lower())
        self.assertNotIn("#3b82f6", CSS.lower())

    def test_todo_token_de_cor_usado_esta_definido(self):
        used = set(re.findall(r"var\(--([\w-]+)", CSS + "".join(SOURCES.values())))
        defined = set(re.findall(r"--([\w-]+)\s*:", CSS))
        self.assertEqual(sorted(used - defined), [], "var(--token) sem definição no :root (ficaria transparente)")

    def test_atributo_hidden_vence_display_dos_componentes(self):
        self.assertRegex(CSS, r"\[hidden\]\s*\{\s*display:\s*none\s*!important")

    def test_toda_classe_usada_tem_estilo(self):
        used = set()
        for text in SOURCES.values():
            for m in re.finditer(r'class="([^"]*)"', text):
                for t in re.sub(r"\$\{(?:[^{}]|\{[^{}]*\})*\}", " ", m.group(1)).split():
                    if re.fullmatch(r"[a-zA-Z][\w-]*", t) and not t.endswith("-") and len(t) > 2:
                        used.add(t)
        defined = set(re.findall(r"\.([a-zA-Z][\w-]*)", re.sub(r"/\*.*?\*/", "", CSS, flags=re.S)))
        missing = sorted(c for c in used - defined - JS_HOOKS)
        self.assertEqual(missing, [], f"classes usadas no HTML/JS sem nenhuma regra no CSS: {missing}")

    def test_sem_estilo_inline_de_cor_ou_tamanho(self):
        for name, text in SOURCES.items():
            bad = re.findall(r'style="[^"]*(?:color|background|font-size)[^"]*"', text)
            bad = [b for b in bad if "${" not in b]                  # cor dinâmica vinda dos dados (ex.: categoria) é permitida
            self.assertEqual(bad, [], f"{name}: mova para o CSS: {bad[:2]}")


if __name__ == "__main__":
    unittest.main()
