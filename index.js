const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const crypto = require("crypto");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const ffmpegPath = ffmpegInstaller.path;

const app = express();
const PORT = process.env.PORT || 1524;

app.use(cors());
app.use(express.json({ limit: "500mb" }));
app.use("/videos", express.static(path.join(__dirname, "videos")));

// Função para executar comandos
function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (err, stdout, stderr) => {
      if (err) return reject({ err, stdout, stderr });
      resolve({ stdout, stderr });
    });
  });
}

// Função para gerar nome único para os arquivos
function generateUniqueName(base = "video") {
  return `${base}-${crypto.randomBytes(8).toString("hex")}`;
}

// Função para salvar o vídeo codificado em base64
async function saveBase64Video(base64, filepath) {
  const buffer = Buffer.from(base64, "base64");
  fs.writeFileSync(filepath, buffer);
}

// Função para sobrepor o vídeo com o fundo
async function overlayOnBG(videoFile, bgFile, outputFile, topCrop) {
  const cmd = `"${ffmpegPath}" -y -i "${bgFile}" -i "${videoFile}" -filter_complex "\
[0:v]scale=1080:1080[bg];[1:v]scale=800:800[vid];[bg][vid]overlay=(W-w)/2:${topCrop}:format=auto[out]" \
-map "[out]" -map 1:a -c:v libx264 -crf 18 -preset veryfast -c:a mp3 -b:a 192k -ac 2 "${outputFile}"`;

  await run(cmd); // Executa o comando para overlay
}

// Rota para processar o vídeo
app.post("/process-video", async (req, res) => {
  const { data, top = 110, debug = false, text1 = null } = req.body; // Recebe o top (margem) via body
  if (!data) return res.status(400).json({ error: "data é obrigatório." });

  const uniqueName = generateUniqueName();
  const tmpDir = path.join(__dirname, "videos");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

  const inputFile = path.join(tmpDir, `${uniqueName}-input.mp4`);
  const tmpOverlay = path.join(tmpDir, `${uniqueName}-overlay.mp4`);
  const finalFile = path.join(tmpDir, `${uniqueName}-final.mp4`);
  const bgImage = path.join(__dirname, text1 || "back.png");
  // Sua imagem de fundo

  try {
    await saveBase64Video(data, inputFile); // Salva o vídeo enviado
    await overlayOnBG(inputFile, bgImage, tmpOverlay, top); // Coloca o vídeo sobre a imagem de fundo

    // Gerar o arquivo final com áudio em mp3
    const cmdFinal = `"${ffmpegPath}" -y -i "${tmpOverlay}" -c:v libx264 -crf 18 -preset veryfast -c:a mp3 -b:a 192k -ac 2 "${finalFile}"`;
    await run(cmdFinal); // Executa o comando final para gerar o vídeo com áudio

    // Convertendo o vídeo final para base64
    const finalBase64 = fs.readFileSync(finalFile).toString("base64");

    // Gerando a URL do vídeo final
    const url = `${req.protocol}://${req.get("host")}/videos/${path.basename(finalFile)}`;

    // Limpeza de arquivos temporários
    [inputFile, tmpOverlay].forEach((f) => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });

    return res.json({
      url,
      base64: finalBase64,
      debugUrl: debug
        ? `${req.protocol}://${req.get("host")}/videos/${path.basename(finalFile)}`
        : undefined,
    });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ error: "Erro interno no processamento do vídeo.", details: e });
  }
});

app.post("/tucano", async (req, res) => {
  const {
    text = "",
    text1 = "",
    marginLeft = 20,
    marginRight = 20,
    top = 20,
    maxCharsPerLine = 31, // Mudamos para 26, como pedido
  } = req.body;

  const uniqueName = generateUniqueName();
  const outputDir = path.join(__dirname, "videotucano");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  const tmpFramesVideo = path.join(outputDir, `${uniqueName}-frames.mp4`);
  const tmpVideoWithText = path.join(outputDir, `${uniqueName}-with-text.mp4`);
  const finalFile = path.join(outputDir, `${uniqueName}-final.mp4`);

  const bgImage = path.join(__dirname, "backgroundtucano.png");
  const fontPath = path.join(__dirname, "HelveticaNeueMedium.otf");
  const audioFile = path.join(__dirname, "tucano.mp3");

  // Função para quebrar texto em linhas com base no limite de caracteres
  function splitTextToLines(text, maxChars) {
    const words = text.split(" ");
    const lines = [];
    let currentLine = "";

    for (const word of words) {
      if ((currentLine + " " + word).trim().length <= maxChars) {
        currentLine = (currentLine + " " + word).trim();
      } else {
        if (currentLine) {
          lines.push(currentLine);
        }
        currentLine = word;
      }
    }

    if (currentLine) lines.push(currentLine);
    return lines;
  }

  try {
    // 1️⃣ Criar vídeo contínuo de 15s
    const cmdFrames = `"${ffmpegPath}" -y -loop 1 -i "${bgImage}" -t 15 -r 25 -c:v libx264 -pix_fmt yuv420p "${tmpFramesVideo}"`;
    await run(cmdFrames);

    // 2️⃣ Preparar textos do body
    const texts = [];
    if (text.trim() !== "")
      texts.push({
        text,
        top,
        marginLeft,
        marginRight,
        fontSize: 60,
        align: "left",
      });
    if (text1.trim() !== "")
      texts.push({
        text: text1,
        top,
        marginLeft,
        marginRight,
        fontSize: 28,
        align: "left",
      });

    // 3️⃣ Aplicar drawtext
    if (texts.length > 0) {
      const drawtextFilters = [];

      for (const t of texts) {
        const lines = splitTextToLines(t.text, maxCharsPerLine);
        let lineY = t.top;

        for (const line of lines) {
          const escapedText = line
            .replace(/\\/g, "\\\\\\\\")
            .replace(/'/g, "\\\\'")
            .replace(/:/g, "\\:")
            .replace(/,/g, "\\,");

          const xExpr =
            t.align === "right" ? `w-tw-${t.marginRight}` : `${t.marginLeft}`;

          drawtextFilters.push(
            `drawtext=fontfile='${fontPath}':text='${escapedText}':x=${xExpr}:y=${lineY}:fontsize=${t.fontSize}:fontcolor=white`,
          );
          lineY += t.fontSize + 10;
        }
      }

      const filterStr = drawtextFilters.join(",");
      const cmdText = `"${ffmpegPath}" -y -i "${tmpFramesVideo}" -vf "${filterStr}" -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p "${tmpVideoWithText}"`;
      await run(cmdText);
    } else {
      fs.copyFileSync(tmpFramesVideo, tmpVideoWithText);
    }

    // 4️⃣ Adicionar áudio de 15 segundos
    const cmdAudio = `"${ffmpegPath}" -y -i "${tmpVideoWithText}" -i "${audioFile}" -c:v copy -c:a aac -b:a 192k -t 15 "${finalFile}"`;
    await run(cmdAudio);

    // 5️⃣ Limpar temporários
    [tmpFramesVideo, tmpVideoWithText].forEach((f) => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });

    // 6️⃣ Retornar vídeo final
    const finalBase64 = fs.readFileSync(finalFile).toString("base64");
    const url = `${req.protocol}://${req.get("host")}/videotucano/${path.basename(finalFile)}`;

    return res.json({ url, base64: finalBase64 });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ error: "Erro interno no processamento do vídeo.", details: e });
  }
});

app.listen(PORT, () => {
  console.log(`🎬 API de vídeo rodando em http://localhost:${PORT}`);
});
