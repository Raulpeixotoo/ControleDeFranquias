# Melhorias futuras

## Rascunhos e alterações pendentes no navegador

**Estado: ideia aprovada para estudar depois; implementação ainda não autorizada.**

Objetivo: preservar o trabalho de quem está editando se o servidor ou o banco ficar indisponível, com uma indicação confiável de onde cada alteração está salva.

Comportamento desejado:

- Salvar rascunhos de formulários automaticamente em IndexedDB.
- Guardar uma alteração localmente antes de tentar enviá-la ao servidor.
- Mostrar estados claros: “Rascunho salvo neste navegador”, “Aguardando envio”, “Enviando”, “Salvo no servidor” e “Precisa de revisão”.
- Exibir a quantidade de alterações pendentes e permitir revisá-las.
- Preservar os itens ao fechar e reabrir o navegador.
- Tentar sincronizar quando o servidor voltar a responder, sem depender apenas do indicador de internet do navegador.
- Remover um item da fila somente após a confirmação do servidor.

Cuidados necessários no desenho:

- Usar identificadores únicos de operação e idempotência no servidor, para não duplicar registros quando uma resposta se perde.
- Detectar versões conflitantes quando outra pessoa altera o mesmo registro; pedir revisão em vez de sobrescrever silenciosamente.
- Respeitar a ordem das operações e as relações entre registros novos, edições e exclusões.
- Separar rascunhos e filas por sistema, banco e usuário para não misturar ambientes ou pessoas.
- Não armazenar credenciais do banco na fila; tratar perda de autorização sem descartar o trabalho pendente.
- Tratar falhas de armazenamento e limites de espaço, inclusive fotos.

Limites a comunicar: salvar no navegador não é backup do banco. Limpar os dados do site ou usar outro computador pode deixar os rascunhos indisponíveis.

Primeira entrega sugerida: rascunhos dos formulários e indicação de salvamento; em seguida, fila de alterações com revisão e sincronização segura.

Nada desta funcionalidade foi implementado nesta organização do projeto.
