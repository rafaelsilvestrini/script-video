# Processamento local de imagens — candidato

`POST /process-image`, `Content-Type: application/json`.

Entrada binária por padrão:

```json
{"data":"BASE64_PURO_DA_IMAGEM"}
```

Resposta200: bytes JPEG, `Content-Type: image/jpeg`, `Cache-Control: no-store`. Resultado1080×1080. Logo original, linha verde e dois pequenos detalhes externos. A fonte inteira é ajustada proporcionalmente dentro de940×940, sem corte, sem texto novo e sem remover créditos. Não há OCR, prompt, chamada de IA ou serviço externo.

Para consumidores que exigem URL:

```json
{"data":"BASE64_PURO_DA_IMAGEM","returnUrl":true}
```

Resposta200 JSON: `url`, `expiresAt` (UTC/ISO), `mimeType: image/jpeg`. Configurar `IMAGE_PUBLIC_BASE_URL` com uma origem HTTPS fixa e sem caminho, credenciais, query ou fragmento. Exemplo do ambiente autorizado: `https://teste.fibrazil.es`. Não existe fallback para o cabeçalho Host.

`GET /image-output/:token.jpg` devolve o JPEG ou404 se expirado/indisponível. Token aleatório de128bits. Os bytes ficam somente em memória: máximo32 imagens e32MiB no total, prazo30min. Limpeza a cada minuto e em cada consulta/gravação. Entradas válidas não são expulsas para abrir espaço; cache cheio retorna503. Um reinício perde todas as URLs. Em múltiplas réplicas, o cache é individual: exige afinidade de roteamento ou desenho posterior de cache compartilhado. O prazo deve cobrir a leitura efetiva pela Meta; não enviar URL expirada para tentativa posterior.

Validação: base64 canônico puro de até10MiB; JPG suportado (SOF0/1/2), PNG e WebP estáticos; dimensão até4096 por lado e16 milhões de pixels. SVG, GIF, URLs, data URLs, título e campos desconhecidos são rejeitados. APNG e WebP animado são rejeitados. Cabeçalhos PNG/JPEG duplicados e dimensões WebP inconsistentes são rejeitados antes do decodificador. JPEG é varrido até EOI, incluindo entropy FF00, restart markers e múltiplos SOS de JPEG progressivo; novo SOF após SOS também é rejeitado. DNL e extensões hierárquicas são rejeitados. O FFmpeg valida a codificação restante.

Limites operacionais: JSON da rota15MiB; dois processamentos simultâneos por instância; FFmpeg30s, uma thread de decodificação/filtro/saída, buffers de log1MiB, limite de128MiB por alocação FFmpeg (não é limite global de RAM), limite de16000000 pixels também no decodificador (`-max_pixels`, confirmado no binário e por teste que rejeita a mesma imagem válida com limite1 e aceita com16000000), codecs de imagem explícitos e protocolos locais `file,pipe`. Custos de CPU/RAM continuam existindo; não há custo por geração de IA.

Erros:400 para entrada inválida,413 para corpo JSON acima do limite,422 para imagem indecodificável/falha/timeout,429 para dois trabalhos ativos,503 para cache indisponível/cheio. Não incluir imagem, base64, conteúdo ou saída do FFmpeg nos logs/respostas de erro.

Arquivos intermediários ficam em subdiretório único `image-*` sob o diretório temporário existente. O `finally` remove esse subdiretório após sucesso ou erro; contador de trabalhos é liberado mesmo se a remoção falhar. Nenhum JPEG final é salvo na pasta pública `output`. Uma interrupção abrupta do processo/sistema pode impedir o `finally`; operação deve tratar temporários órfãos, sem presumir garantia contra desligamento forçado.

Integração n8n pendente do coordenador: baixar origem para binário, converter somente o campo de imagem para base64, chamar endpoint, usar os bytes ou a URL temporária e consumir antes do prazo. Preservar legenda/campos editoriais. Não publicar no WordPress como armazenamento permanente de imagens das redes. Não repetir estilização em imagem já processada.

## Validação local

Suíte: `node --test test/*.test.js`, com `FFMPEG_PATH` apontando ao binário verificado e `VERIFIED_NODE_MODULES`/`NODE_PATH` às dependências oficiais instaladas separadamente. Testes de render com PNG horizontal, JPEG quadrado e WebP vertical verificam quatro cantos preservados, JPEG1080² e pasta temporária vazia. Testes cobrem entradas inválidas, falha FFmpeg, título indevido, headers duplicados, limites/expiração de cache, URL fixa e parser HTTP. A fixture JPEG malformada da revisão independente também deve ser rejeitada.

A demonstração usa o arquivo local ilustrado de campo de futebol (`soccer2.png`), não representa uma notícia nem uma imagem obtida de terceiros nesta etapa. A versão original e a versão com identidade foram salvas em outputs para revisão. Não houve push, deploy ou integração n8n nesta fatia.
