# Teste gratuito no Render com Neon

Esta versão mantém SQLite no computador e usa PostgreSQL quando `DATABASE_URL` está definida.
O banco local e o banco online são independentes: alterações online não voltam automaticamente para o SQLite.
O código foi preparado e testado localmente. A velocidade real no Neon/Render precisa ser medida após a publicação.

## 1. Criar o banco de teste

1. No Neon, crie um projeto gratuito separado, com banco vazio. Não reutilize o banco antigo com dados.
2. Para combinar com o `render.yaml`, escolha **AWS / US East (N. Virginia), us-east-1**.
3. Em **Connect**, habilite **Connection pooling** e copie a URL PostgreSQL completa. Mantenha `sslmode=require` e os demais parâmetros fornecidos pelo Neon.
4. Guarde a URL em local privado. Ela inclui a senha. Não coloque a URL nos arquivos, no GitHub nem em capturas de tela.

## 2. Copiar seus dados locais para o Neon

Execute `migrar_para_neon.bat` na pasta original do projeto, onde está `franquias.db`.

1. O programa instala as dependências e pede a URL do banco de teste. Ao colar, os caracteres não aparecem.
2. Digite `MIGRAR` para autorizar o envio.
3. Ele cria o esquema, copia os registros preservando IDs e vínculos e confere as contagens.
4. O SQLite local fica intacto. O programa recusa destino com dados e faz a cópia em uma transação.

Se falhar na conexão, o programa mostra um diagnóstico sem exibir credenciais: DNS, autenticação, conexão segura, recusa ou demora na resposta. A migração usa uma única conexão direta do driver em vez de esconder a causa em um `PoolTimeout`. Isso não exige desativar o Connection pooling no painel do Neon.

São copiados unidades, solicitações, usuários, ocorrências com fotos, pipeline, configurações e históricos.
As planilhas originais de upload não são copiadas; os dados já importados estão no banco.
Uma segunda execução contra o mesmo destino é bloqueada para não duplicar ou sobrescrever registros.
Também é possível testar sem migrar: o site inicia vazio e permite importar as planilhas pela interface.

## 3. Subir manualmente para o GitHub

1. Execute `python preparar_upload.py` se precisar gerar o pacote novamente.
2. Extraia `entrega/controle-urgencias-github.zip` em uma pasta separada.
3. Crie um repositório **privado** no GitHub.
4. Abra **Add file → Upload files** e arraste o conteúdo extraído, incluindo as pastas `static` e `tests`.
5. Clique em **Commit changes**. Isso é feito inteiramente pelo navegador, sem comandos git.
6. Confira que `app.py`, `requirements.txt` e `render.yaml` estão na raiz do repositório.

Envie o conteúdo extraído, não o ZIP sozinho. Não envie a pasta original do projeto: ela contém banco e planilhas.
O `.gitignore` serve como proteção para ferramentas git, mas não impede que você selecione arquivos particulares no upload pelo navegador.
O pacote já usa uma lista explícita e inclui somente código, testes, exemplos e instruções.

## 4. Criar o serviço gratuito no Render

Opção automática: **New → Blueprint**, conecte o repositório e use o `render.yaml`.
Ele solicita `DATABASE_URL` e `ACCESS_CODE`.

Ou use **New → Web Service** com:

| Campo | Valor |
|---|---|
| Runtime | Python |
| Region | Virginia |
| Instance type | Free |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `gunicorn app:app --bind 0.0.0.0:$PORT --workers 1 --threads 4 --timeout 120 --access-logfile -` |
| Health Check Path | `/healthz` |

Em **Environment**, cadastre:

| Variável | Conteúdo |
|---|---|
| `DATABASE_URL` | A URL completa com pool de conexões do Neon |
| `ACCESS_CODE` | Um código de acesso longo escolhido por você |
| `PYTHON_VERSION` | `3.12.10` |

O app recusa iniciar no Render sem banco remoto e código de acesso, para não gravar em SQLite descartável nem expor os dados sem controle.
Não precisa comprar domínio: use o endereço HTTPS `*.onrender.com` fornecido pelo Render.

## 5. Testar a velocidade

1. Abra o site e informe nome e código de acesso.
2. Espere a primeira carga e navegue entre Unidades, Novas franquias e Solicitações.
3. Abra o DevTools do navegador com F12, entre em **Network/Rede** e filtre por `/api/`.
4. Confira **Duration/Tempo** de `/api/state`, `/api/rev` e `/api/masters`.
5. Nos cabeçalhos da resposta, `Server-Timing` informa tempo total do processamento (`app`) e das consultas (`db`), em milissegundos. O tempo restante pode incluir conexão inicial, transferência e outros trabalhos.
6. Requisições acima de 1,5 segundo geram um aviso de lentidão nos logs do Render, sem registrar dados das consultas ou senhas.

O app reutiliza conexões, usa lotes nas importações, comprime JSON e impede sincronizações automáticas simultâneas.
Uma consulta tem limite de 20 segundos, a espera por bloqueios de 5 segundos e a aquisição de conexão de 12 segundos.
Esses limites não garantem que uma operação inteira de importação termine em 20 segundos.
O navegador limita leituras a 30 segundos e gravações a 120 segundos. Se uma gravação expirar, confira a lista antes de repetir: ela pode ter sido concluída no servidor.

O Render gratuito suspende por inatividade e pode demorar cerca de um minuto na primeira abertura.
O Neon também pode suspender o processamento. Os planos gratuitos têm cotas e não garantem disponibilidade contínua.
Uploads ainda em análise ficam temporários no Render: se houver reinicialização entre análise e confirmação, envie a planilha novamente. Dados confirmados e fotos de ocorrências ficam no Neon.
Os 15 mil usuários ficam numa rota paginada, fora da carga geral do painel.

## Testes para desenvolvimento

```text
python -m unittest discover -s tests -v
python tests/run_ui_smoke.py
```

O primeiro comando usa SQLite temporário. Não execute com `DATABASE_URL` de produção definida.
Para testar PostgreSQL, `tests/run_postgres_tests.py` usa `TEST_POSTGRES_URL` e cria bancos temporários separados, removidos ao final. A conexão precisa permitir criar bancos.

## Referências

- [Upload pelo navegador no GitHub](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)
- [Flask no Render](https://render.com/docs/deploy-flask)
- [Limites do Render gratuito](https://render.com/docs/free)
- [Regiões do Render](https://render.com/docs/regions)
- [Pool de conexões do Neon](https://neon.com/docs/connect/connection-pooling)
