# Controle de urgências — Franchising Team

Gestão de unidades, ocorrências, solicitações Jira, novas franquias e usuários das unidades.
Aplicação Flask com SQLite local ou PostgreSQL no Neon.

## Atalhos

| Arquivo | Função |
|---|---|
| `iniciar.bat` | Abrir o sistema local |
| `preparar_upload.bat` | Gerar o ZIP de código para upload manual no GitHub |
| `migrar_para_neon.bat` | Copiar dados locais para um banco de teste vazio no Neon |

A migração já foi feita para o banco online atual. Não é necessário repeti-la para publicar alterações de código.

## Organização

```text
app.py, database.py, importer.py, pipeline.py, masters.py  Servidor e regras do sistema
static/                                                  Interface
tests/                                                   Testes e exemplos sintéticos
scripts/                                                 Ferramentas de migração e entrega
scripts/legado/                                          Inicializador antigo de túnel
docs/                                                    Documentação e ideias futuras
dados/planilhas/                                         Planilhas originais, somente locais
uploads/                                                 Arquivos temporários de importação
backups/                                                 Cópias de segurança
backups/historico/                                       Backups antigos do banco
entrega/                                                 ZIP para GitHub e capturas de teste
franquias.db                                              Banco local em uso
```

Os módulos do servidor permanecem na raiz para manter `python app.py` e `gunicorn app:app` funcionando.
Não mova `franquias.db`, `franquias.db-wal` ou `franquias.db-shm` enquanto o sistema estiver aberto.
Os arquivos `-wal` e `-shm` são gerenciados pelo SQLite e fazem parte do funcionamento do banco.

## Documentação

- [Publicação manual no GitHub, Render e Neon](docs/ONLINE.md)
- [Melhorias futuras: rascunhos e sincronização pelo navegador](docs/MELHORIAS-FUTURAS.md)
- [Como executar os testes](tests/README.md)

O pacote gerado por `preparar_upload.bat` inclui apenas código, testes e documentação.
Banco, planilhas, uploads, backups e credenciais reais ficam fora do pacote.
O banco local e o online são independentes e não sincronizam alterações automaticamente.
