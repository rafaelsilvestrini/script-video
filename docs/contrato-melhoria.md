# Contrato da melhoria local (proposto antes da implementação)

Base: 129ca27d116b162db734281f692d2ac057f444e1.

- Preservar POST /process-video e POST /tucano e resposta de sucesso { url, base64 }; arquivos continuam em /output.
- Composição quadrada segue 1080×1080 e caixa de vídeo 800×800, centrada horizontalmente e posicionada por top. Conteúdo cabe inteiro na caixa com proporção visual preservada (incluindo SAR), sem esticar; espaço restante branco, coerente com smartCrop. Reels segue seleção e caixa atuais.
- FFmpeg executado diretamente com vetor de argumentos, sem shell. Texto Tucano deve ser lido de arquivos temporários, sem interpolar texto em expressões FFmpeg.
- Validar corpo, tipos, limites numéricos, base64 canônico (até 350 MiB decodificados), nomes de fundo confinados a assets/img e arquivos de imagem existentes. Rejeições de entrada retornam 400 JSON { error }; erro de processamento mantém 500 Erro.
- top de process-video: inteiro 0–280 (caixa 800 alta em canvas 1080). Tucano: strings até 4000 caracteres cada; marginLeft e top inteiros 0–1080/1920; maxCharsPerLine inteiro 1–200. Defaults existentes mantidos.
- Substituir cota de oito arquivos por TTL padrão de 24 horas, configurável OUTPUT_TTL_HOURS com mínimo de 1 hora. Remover apenas outputs gerados com formato conhecido, expirados por mtime e sem trabalho/download ativo no processo. Nenhum arquivo recente é removido pela quantidade de requests.
- Provar validação, confinamento, argumentos, retenção e falhas com node:test e dados sintéticos. Render de proporção condicionado à disponibilidade de FFmpeg local confiável.

Autoavaliação do contrato: top fora da área útil passa a ser rejeitado; base64 malformado e caminhos arbitrários deixam de ser aceitos. TTL é retenção mínima, não garantia de URL permanente. Controle de atividade vale no mesmo processo; uso multiprocesso de output compartilhado exige coordenação externa. Sem redesenho editorial de /tucano, autenticação, fila ou limites de duração/concor­rência. Essas lacunas impedem alegação de segurança completa.
