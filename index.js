const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const jimpModule = require("jimp");
const Jimp = jimpModule.Jimp || jimpModule;
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const ffmpegPath = ffmpegInstaller.path;
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 1524;

app.use(cors());
app.use(express.json({ limit: "500mb" }));
app.use("/videos", express.static(path.join(__dirname, "videos")));
app.use('/videotucano', express.static(path.join(__dirname, 'videotucano')));
function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (err, stdout, stderr) => {
      if (err) return reject({ err, stdout, stderr });
      resolve({ stdout, stderr });
    });
  });
}

function generateUniqueName(base = "video") {
  return `${base}-${crypto.randomBytes(8).toString("hex")}`;
}

async function saveBase64Video(base64, filepath) {
  const buffer = Buffer.from(base64, "base64");
  fs.writeFileSync(filepath, buffer);
}

async function extractFrame(inputFile, frameFile) {
  const cmd = `"${ffmpegPath}" -y -ss 0 -i "${inputFile}" -vframes 1 -q:v 2 "${frameFile}"`;
  await run(cmd);
}

async function detectLargeBlock(
  frameFile,
  minBlockSize = 120,
  pixelThreshold = 20,
  debug = true
) {
  const image = await Jimp.read(frameFile);
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  await image.blur(2);
  const binary = Array.from({ length: height }, () => Array(width).fill(0));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgba = image.getPixelColor(x, y);
      const r = (rgba >> 24) & 255;
      const g = (rgba >> 16) & 255;
      const b = (rgba >> 8) & 255;
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      if (gray < 255 - pixelThreshold) binary[y][x] = 1;
    }
  }
  const visited = Array.from({ length: height }, () =>
    Array(width).fill(false)
  );
  const blocks = [];
  function bfs(sy, sx) {
    const queue = [[sy, sx]];
    let minY = sy,
      maxY = sy,
      minX = sx,
      maxX = sx;
    visited[sy][sx] = true;
    while (queue.length) {
      const [y, x] = queue.shift();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (
            ny >= 0 &&
            ny < height &&
            nx >= 0 &&
            nx < width &&
            !visited[ny][nx] &&
            binary[ny][nx] === 1
          ) {
            visited[ny][nx] = true;
            queue.push([ny, nx]);
            minY = Math.min(minY, ny);
            maxY = Math.max(maxY, ny);
            minX = Math.min(minX, nx);
            maxX = Math.max(maxX, nx);
          }
        }
      }
    }
    const blockWidth = maxX - minX + 1;
    const blockHeight = maxY - minY + 1;
    if (blockWidth >= minBlockSize && blockHeight >= minBlockSize) {
      blocks.push({
        minY,
        maxY,
        minX,
        maxX,
        width: blockWidth,
        height: blockHeight,
      });
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (binary[y][x] === 1 && !visited[y][x]) bfs(y, x);
    }
  }
  if (blocks.length === 0) return null;
  const topBlock = blocks.reduce(
    (prev, curr) => (curr.minY < prev.minY ? curr : prev),
    blocks[0]
  );

  if (debug) {
    const debugFile = frameFile.replace("-frame.jpg", "-debug.jpg");
    const debugImg = image.clone();
    debugImg.scan(0, topBlock.minY, width, 2, (x, y, idx) => {
      debugImg.bitmap.data[idx + 0] = 255;
      debugImg.bitmap.data[idx + 1] = 0;
      debugImg.bitmap.data[idx + 2] = 0;
    });
    await debugImg.write(debugFile);
  }

  return { startY: topBlock.minY, height: topBlock.height };
}

async function applyCrop(inputFile, outputFile, topCrop) {
  const cmd = `"${ffmpegPath}" -y -i "${inputFile}" -vf "crop=in_w:in_h-${topCrop}:0:${topCrop}" -map_metadata -1 -c:v libx264 -crf 18 -preset veryfast -c:a copy "${outputFile}"`;
  await run(cmd);
}

async function applyMirror(inputFile, outputFile) {
  const cmd = `"${ffmpegPath}" -y -i "${inputFile}" -vf "hflip,eq=contrast=1.05:brightness=0.02:saturation=1.1,unsharp=3:3:0.5:3:3:0" -pix_fmt yuv420p -c:v libx264 -crf 21 -preset medium -af "asetrate=44100*0.97,aresample=44100,atempo=1.03" -map_metadata -1 -c:a aac -b:a 128k "${outputFile}"`;
  await run(cmd);
}

async function overlayOnBG(videoFile, bgFile, outputFile, topCrop) {
  const cmd = `"${ffmpegPath}" -y -i "${bgFile}" -i "${videoFile}" -filter_complex "[0:v]scale=720:720[bg];[bg][1:v]overlay=x=0:y=${topCrop}" -c:v libx264 -crf 18 -preset veryfast -c:a copy "${outputFile}"`;
  await run(cmd);
}

function splitText(text, maxLength = 40) {
  const result = [];
  let currentText = text;
  while (currentText.length > maxLength) {
    let segment = currentText.slice(0, maxLength);
    let lastSpaceIndex = segment.lastIndexOf(" ");
    if (lastSpaceIndex === -1) {
      result.push(segment);
      currentText = currentText.slice(maxLength);
    } else {
      segment = currentText.slice(0, lastSpaceIndex);
      result.push(segment);
      currentText = currentText.slice(lastSpaceIndex + 1);
    }
  }
  if (currentText.length > 0) result.push(currentText);
  return result;
}

async function overlayMultipleTexts(inputVideo, outputVideo, texts, fontPath) {
  if (!texts || texts.length === 0) {
    fs.copyFileSync(inputVideo, outputVideo);
    return;
  }
  const drawtextArray = [];
  texts.forEach((t) => {
    if (!t.text) return;
    const lines = splitText(t.text, 55);
    let lineY = t.y;
    lines.forEach((line) => {
      drawtextArray.push({
        text: line,
        x: t.x || 40,
        y: lineY,
        fontSize: t.fontSize || 28,
        fontColor: t.fontColor || "white",
        box: t.box || false,
        boxColor: t.boxColor || "white@0",
      });
      lineY += 32;
    });
  });
  if (drawtextArray.length === 0) {
    fs.copyFileSync(inputVideo, outputVideo);
    return;
  }
  const drawtextFilters = drawtextArray.map((t) => {
    const escapedText = t.text
      .replace(/\\/g, "\\\\\\\\")
      .replace(/'/g, "\\\\'")
      .replace(/:/g, "\\:")
      .replace(/,/g, "\\,");
    return `drawtext=fontfile='${fontPath}':text='${escapedText}':x=${t.x}:y=${
      t.y
    }:fontsize=${t.fontSize}:fontcolor=${t.fontColor}${
      t.box ? `:box=1:boxcolor=${t.boxColor}:boxborderw=5` : ""
    }`;
  });
  const filterComplex = drawtextFilters.join(",");
  const cmd = `"${ffmpegPath}" -y -i "${inputVideo}" -vf "${filterComplex}" -c:v libx264 -crf 18 -preset veryfast -c:a copy "${outputVideo}"`;
  await run(cmd);
}

async function overlayLogo(videoFile, logoFile, outputFile, top = 200) {
  const cmd = `"${ffmpegPath}" -y -i "${videoFile}" -i "${logoFile}" -filter_complex "\
[1:v]scale=-1:60:force_original_aspect_ratio=decrease,format=rgba,\
geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(pow(X-30,2)+pow(Y-30,2),30*30),255,0)'[circle];\
[1:v]scale=-1:64:force_original_aspect_ratio=decrease,format=rgba,\
geq=r='255':g='255':b='255':a='if(lte(pow(X-32,2)+pow(Y-32,2),32*32),255,0)'[border];\
[border][circle]overlay=(W-w)/2:(H-h)/2[circled];\
[0:v][circled]overlay=(main_w-overlay_w)/2:y=${top}:format=auto" \
-c:v libx264 -crf 18 -preset veryfast -c:a copy "${outputFile}"`;

  await run(cmd);
}

app.post("/process-video", async (req, res) => {
  const { data, text = "", text1 = "", debug = false } = req.body;
  if (!data) return res.status(400).json({ error: "data é obrigatório." });

  const uniqueName = generateUniqueName();
  const tmpDir = path.join(__dirname, "videos");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

  const inputFile = path.join(tmpDir, `${uniqueName}-input.mp4`);
  const frameFile = path.join(tmpDir, `${uniqueName}-frame.jpg`);
  const debugFile = path.join(tmpDir, `${uniqueName}-debug.jpg`);
  const tmpCrop = path.join(tmpDir, `${uniqueName}-crop.mp4`);
  const tmpMirror = path.join(tmpDir, `${uniqueName}-mirror.mp4`);
  const tmpOverlay = path.join(tmpDir, `${uniqueName}-overlay.mp4`);
  const tmpLogo = path.join(tmpDir, `${uniqueName}-logo.mp4`);
  const finalFile = path.join(tmpDir, `${uniqueName}-final.mp4`);
  const bgImage = path.join(__dirname, "observei_bg3.png");
  const fontPath = path.join(__dirname, "HelveticaNeueMedium.otf");
  const logoFile = path.join(__dirname, "logo.png");

  const tempFiles = [
    inputFile,
    tmpCrop,
    tmpMirror,
    tmpOverlay,
    frameFile,
    tmpLogo,
  ];

  try {
    await saveBase64Video(data, inputFile);
    await extractFrame(inputFile, frameFile);

    const detected = await detectLargeBlock(frameFile, 200, 60, debug);

    if (!detected || detected.height < 20 || detected.startY > 0.8 * 720) {
      return res
        .status(400)
        .json({ error: "Não foi detectado bloco válido para corte." });
    }

    await applyCrop(inputFile, tmpCrop, detected.startY);
    await applyMirror(tmpCrop, tmpMirror);

    // Centraliza verticalmente
    const topForOverlay = Math.floor((720 - detected.height) / 2);
    await overlayOnBG(tmpMirror, bgImage, tmpOverlay, topForOverlay);

    // Overlay da logo sobre o vídeo centralizado
    await overlayLogo(tmpOverlay, logoFile, tmpLogo, 137);

    const texts = [
      { text, x: 20, y: 20, fontSize: 24 },
      { text: text1, x: 130, y: 90, fontSize: 24 },
    ];

    await overlayMultipleTexts(tmpLogo, finalFile, texts, fontPath);

    const finalBase64 = fs.readFileSync(finalFile).toString("base64");
    const url = `${req.protocol}://${req.get("host")}/videos/${path.basename(
      finalFile
    )}`;
    const debugUrl = debug
      ? `${req.protocol}://${req.get("host")}/videos/${path.basename(
          debugFile
        )}`
      : undefined;

    tempFiles.forEach((f) => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
    if (!debug && fs.existsSync(debugFile)) fs.unlinkSync(debugFile);

    return res.json({
      url,
      base64: finalBase64,
      debugUrl: debug ? debugUrl : undefined,
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
    maxCharsPerLine = 31  // Mudamos para 26, como pedido
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
    if (text.trim() !== "") texts.push({ text, top, marginLeft, marginRight, fontSize: 60, align: "left" });
    if (text1.trim() !== "") texts.push({ text: text1, top, marginLeft, marginRight, fontSize: 28, align: "left" });

    // 3️⃣ Aplicar drawtext
    if (texts.length > 0) {
      const drawtextFilters = [];

      for (const t of texts) {
        const lines = splitTextToLines(t.text, maxCharsPerLine);
        let lineY = t.top;

        for (const line of lines) {
          const escapedText = line.replace(/\\/g, "\\\\\\\\").replace(/'/g, "\\\\'").replace(/:/g, "\\:").replace(/,/g, "\\,");

          const xExpr = t.align === "right"
            ? `w-tw-${t.marginRight}`
            : `${t.marginLeft}`;

          drawtextFilters.push(`drawtext=fontfile='${fontPath}':text='${escapedText}':x=${xExpr}:y=${lineY}:fontsize=${t.fontSize}:fontcolor=white`);
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
    [tmpFramesVideo, tmpVideoWithText].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });

    // 6️⃣ Retornar vídeo final
    const finalBase64 = fs.readFileSync(finalFile).toString("base64");
    const url = `${req.protocol}://${req.get("host")}/videotucano/${path.basename(finalFile)}`;

    return res.json({ url, base64: finalBase64 });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erro interno no processamento do vídeo.", details: e });
  }
});


app.listen(PORT, () => {
  console.log(`🎬 API de vídeo rodando em http://localhost:${PORT}`);
});
