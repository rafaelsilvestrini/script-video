# script-video

API Express para compor vídeos com FFmpeg. A melhoria local preserva as rotas e a resposta `{ url, base64 }`. A composição quadrada mantém canvas 1080×1080 e caixa 800×800; o vídeo cabe inteiro, sem deformação, com espaço branco quando necessário. A posição vertical da caixa continua controlada por `top`.

Os MP4 finais usam H.264 com pixels `yuv420p` (4:2:0), áudio AAC a 128 kb/s, 48 kHz e dois canais quando houver áudio, e `+faststart` para colocar o índice `moov` antes da mídia. Vídeos de entrada sem áudio continuam sem faixa de áudio. O encode de texto de Tucano também fixa `yuv420p`, e o MP4 final usa AAC e faststart. Dimensões, layout, duração e contratos das rotas são preservados. Essas opções atendem a esses requisitos de compatibilidade; não comprovam todos os limites nem a aceitação pelas plataformas.

Referências: [amostra oficial Meta para publicação de Reels](https://github.com/fbsamples/reels_publishing_apis/blob/main/insta_reels_publishing_api_sample/README.md#reels-requirements-for-publishing), [FFmpeg: formato de pixels](https://ffmpeg.org/ffmpeg.html#Advanced-Video-options), [FFmpeg: faststart](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv).

## Contratos

- `POST /process-video`: JSON com `data` (base64 puro e canônico, até 350 MiB decodificados), `top` (inteiro 0–280, padrão 110), `text1` (nome de imagem existente diretamente em `assets/img`, padrão `back.png`), `isCut` e `debug` (booleanos, padrão false). Nomes permitidos usam letras, números, `_`, `-` e extensão png/jpg/jpeg/webp. Imagens ausentes ou links para fora de `assets/img` são rejeitados. A seleção de Reels e seu layout permanecem como antes; `top` e fundo escolhido afetam o ramo quadrado.
- `POST /tucano`: `text` e `text1` são strings até 4000 caracteres cada, sem NUL; `marginLeft` inteiro 0–1080 (20), `top` inteiro 0–1920 (20), `maxCharsPerLine` inteiro 1–200 (31). Máximo de 120 linhas geradas por campo. O layout, fonte, duração, áudio e algoritmo de quebra de palavras existentes são mantidos. Texto é lido literalmente de arquivos temporários; expressões `%{...}` não são expandidas.
- Sucesso: JSON `{ url, base64 }`, com URL em `/output/<nome>.mp4`. Entrada inválida: 400 JSON `{ error }`. JSON malformado retorna 400, corpo acima do limite de 500 MiB retorna 413 e charset/codificação não suportados retornam 415, sempre com JSON de mensagem fixa, sem repetir corpo ou stack nem registrar esses detalhes. Falha de processamento: 500 com `Erro`. Base64 válido não garante mídia válida.
- Temporários são removidos tanto no sucesso quanto na falha. Debug de crop usa um nome por request, evitando sobrescrever outros requests.

Os tipos e limites acima são mais estritos que a implementação anterior: valores numéricos em strings, base64 com prefixo data-URI, nomes com espaços e caminhos arbitrários não são aceitos.

## Execução e retenção

`node index.js` inicia na porta `PORT` (padrão 1524). `FFMPEG_PATH` pode apontar a um executável local confiável; sem a variável, o instalador FFmpeg existente fornece o binário. FFmpeg recebe argumentos diretamente, sem shell. Dependências devem ser instaladas e revisadas pelo operador; os testes abaixo não carregam o `node_modules` versionado.

`OUTPUT_TTL_HOURS` define retenção, padrão 24 horas, mínimo 1 hora e máximo 8760. Configuração inválida impede a inicialização. A limpeza acontece após gerações bem-sucedidas, considera a última modificação e remove somente nomes de outputs reconhecidos, incluindo o formato legado de oito dígitos. A quantidade de requests não remove arquivos recentes. Outputs em geração e downloads ativos neste processo ficam protegidos; um download iniciado depois da expiração não tem garantia. Arquivos externos, diretórios e links simbólicos não são apagados. O antigo `debug-linhas.png` não é removido automaticamente. Sem novas gerações, arquivos expirados podem permanecer no disco.

Um diretório `output` compartilhado por múltiplos processos precisa de coordenação externa: a proteção de atividade é local ao processo. URLs são temporárias e públicas. Esta mudança não adiciona autenticação, fila, limites de duração, isolamento de codecs ou garantia de segurança completa; tamanho base64, memória e trabalho concorrente ainda exigem controles operacionais. Logs de falha evitam imprimir conteúdo das requisições e texto FFmpeg. Revise versão/origem do FFmpeg e dependências antes de uso exposto.

## Verificação local

Use `node --check index.js`, `node --check video-tools.js` e `node --test`. Em hosts que impedem o subprocesso do runner, Node recente permite `node --test --test-isolation=none`. Os testes usam módulos nativos, arquivos sintéticos e handlers com dependências simuladas; eles não representam um teste HTTP real com Express.

Os dois testes de render são opcionais: configure `FFMPEG_PATH` para um FFmpeg local confiável antes de executar `node --test`. Eles renderizam fontes horizontais, verticais e com SAR 2, medem o retângulo visível dentro de 1080×1080 e verificam a desativação de expansão de `%{...}` por comparação de pixels, com controle positivo da expressão renderizada como `2`. Pontuação também é exercitada em um render separado. Sem a variável, esses testes são explicitamente pulados. A prova de confinamento por symlink também é pulada se o host não permitir criá-lo.

Para o teste HTTP opcional, configure `VERIFIED_NODE_MODULES` com caminho absoluto para `node_modules` de uma instalação oficial isolada de Express 5.1.0 e CORS 2.8.5. O teste inicia somente um servidor em `127.0.0.1` com porta efêmera. O limite do parser é reduzido apenas no teste para exercitar 413 com fixture pequena; o teste confirma que a produção continua configurada com `500mb`. JSON malformado, charset não suportado, mensagens sem corpo/stack e ausência de logs são verificados nas duas rotas. Sem a variável, ele é pulado.

## Rollback

Antes de integrar, guarde esta melhoria em patch ou commit próprio. Para desfazer, reverta somente essa entrega e retorne à base `129ca27d116b162db734281f692d2ac057f444e1`, preservando alterações posteriores e os diretórios de mídia. Não exige migração de dados. O rollback reintroduz a deformação e a limpeza por quantidade da versão anterior; avalie esse efeito antes de reiniciar.
