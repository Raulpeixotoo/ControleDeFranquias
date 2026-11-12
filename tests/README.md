# Testes

| Comando | O que cobre |
|---|---|
| `python -m unittest discover -s tests -v` | API (importações, atualização mensal, pipeline, solicitações, ranking, link do Jira) e regras de design da interface |
| `python tests/run_ui_smoke.py [pasta-de-capturas]` | Navegador (Chrome/Edge headless): todas as abas, diálogos, uploads com comparação, arrastar-e-soltar, edição de célula, contraste no tema escuro |

Os dois usam banco temporário e planilhas de exemplo geradas em memória (`tests/fixtures.py`); nunca tocam em `franquias.db`.
