# Fontes dos fundos de vídeo Observei

`back.svg` e `background-story.svg` são as fontes declarativas de manutenção. O serviço continua consumindo somente `assets/img/back.png` (1080×1080) e `assets/img/background-story.png` (1080×1920); SVG e rasterizador não são dependências do servidor.

Paleta: navy `#121827`, lima `#D5FF55`, offwhite `#F7F5EF`. Nenhum slogan, URL ou vinheta. O PNG original do wordmark foi embutido em cada SVG sem mudar seus bytes: SHA-256 `a135f798dd54629ee78e0906298443c7efd4e0530307d184cd6d8303be3fe2d3`. Seu viewport remove as margens transparentes e ruído de alpha quase invisível; nenhuma letra foi redesenhada. O arquivo original tem 2172×724; o viewport visível é `175 142 1812 420`.

Geometria anterior do quadrado (substituída pela candidata B ao final): canvas 1080²; cartucho offwhite x140/y20, 280×72; wordmark contido em x156/y28, 248×56; acento lima x140/y100, 800×4; todo o corpo navy, inclusive sob a caixa x140/y110, 800². A geometria do filtro é preservada; apenas sua cor de padding e a do padding de smartCrop passam de branco para navy `#121827`, evitando faixas brancas na composição. A fonte SVG também não deixa um recorte claro aparecer quando top é personalizado. Com top110, fonte16:9 ocupa x140/y285, 800×450; fonte1:1 ocupa x140/y110, 800². top personalizado pode encobrir a marca do fundo, mas ela fica atrás do vídeo e não encobre a fonte.

Geometria Story: canvas 1080×1920; faixa offwhite y0–59; wordmark contido em x48/y10, 200×40; acento lima y56–59. A composição existente limita vídeo a 938×1800 centrado, portanto começa em y60 ou abaixo e termina até y1860. Esses limites são do compositor; não representam garantia de área segura da interface de Instagram/Facebook. Conferir prévia em celular.

## Gerar candidatos

Rasterizador de manutenção: `@resvg/resvg-js@2.6.2`, publicado no registro oficial npm; instalar isoladamente com scripts desativados. Exemplo:

```sh
npm install --prefix ../video-template-tools --ignore-scripts --no-audit --no-fund @resvg/resvg-js@2.6.2
NODE_PATH=../video-template-tools/node_modules node scripts/render-video-backgrounds.js /caminho/candidatos
```

No PowerShell, definir `$env:NODE_PATH` com o caminho absoluto de `../video-template-tools/node_modules`, depois executar o mesmo comando Node. O script exige destino explícito, confirma versão do rasterizador, dimensões e amostras RGBA nas bordas das regiões. Não aplica os candidatos automaticamente em `assets/img`.

Checks nativos: `node --test test/templates.test.js`. A verificação dos bytes embutidos sempre roda; rasterização é pulada explicitamente se o rasterizador não estiver disponível via NODE_PATH. Para render de aceitação, definir `FFMPEG_PATH` com binário local confiável e executar:

```sh
node scripts/preview-video-backgrounds.js /caminho/candidatos /caminho/previas
```

O script usa fontes sintéticas16:9,1:1,9:16, com créditos nos quatro cantos, confirma preservação de marcadores por pixels e exporta MP4, frames1080px e prévias360px. Escreve apenas no destino explícito e em uma pasta temporária própria. Não lê mídias de clientes nem executa workflows. Inspecionar as prévias além dos checks.

## Aplicar e reverter

Após revisão visual, copiar somente os dois PNGs aprovados para seus nomes correspondentes em `assets/img`. Nenhuma mudança de rota, resolução, codec, áudio ou duração é necessária. Não regenerar nem alterar Tucano, soccer ou outros assets nesta fatia. Na primeira entrega de identidade, reverter somente os dois PNGs retornava à marca anterior; para a candidata B, seguir a reversão de código indicada ao final; preservar mídias/outputs existentes.

Os candidatos iniciais de imagegen foram rejeitados para produção: dimensões1254² e916×1717, além de gradientes/textura onde se pediu cor plana. Foram guardados como referências, sem redimensioná-los ou retocá-los para simular conformidade. A alternativa SVG foi autorizada para obter geometria exata e preservar o wordmark.

Referência do rasterizador: https://github.com/thx/resvg-js .

## Candidata B — revisão móvel de 2026-11-03

Para `back.png`, a janela passou de 800 para 940 px. Com top=110, começa em x70/y110 e termina em y1050: margem inferior de 30 px. A faixa do logo original não mudou; somente o acento lima foi ampliado de x140/800 para x70/940. Fonte16:9 ocupa x70/y316, 940×528; fonte1:1 ocupa940². Isso aumenta a largura em17,5% e a área em aproximadamente38%, sem cortar a fonte. O arredondamento para dimensões pares é necessário para codificação4:2:0.

A rota aplica a ampliação somente quando o fundo é `back.png`. Outros fundos conservam a caixa800. O helper mantém800 como padrão. Para top personalizado, a caixa é limitada à altura restante e arredondada para par; top280 continua800. Valores top abaixo da marca ainda podem ocultá-la, como no contrato anterior; o fluxo padrão usa110.

O Reels permanece938×1800, centrado e sem corte. A ampliação vertical fica pendente de prévia real da plataforma: os testes locais confirmam os pixels da fonte, não a posição dos controles do Instagram/Facebook.

Os renders sintéticos cobrem16:9,1:1,9:16, créditos e marcadores nos quatro cantos. Não comprovam retenção. Texto longo gravado na fonte continua exigindo alteração upstream.

A candidata exige publicar código e `back.png` juntos após aceite. Reverter apenas o PNG não desfaz a geometria: reverter também a seleção940 na rota. Nenhum deploy foi executado nesta revisão local.
