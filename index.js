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

const DIRS = {
    temp: path.join(__dirname, "temp_videos"),
    output: path.join(__dirname, "output"),
    assets: path.join(__dirname, "assets"),
    img: path.join(__dirname, "assets", "img"),
    fonts: path.join(__dirname, "assets", "fonts"),
    audio: path.join(__dirname, "assets", "audio")
};

Object.values(DIRS).forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(cors());
app.use(express.json({ limit: "500mb" }));
app.use("/output", express.static(DIRS.output));

function run(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
            if (err) return reject({ err, stdout, stderr });
            resolve({ stdout, stderr });
        });
    });
}

function generateUniqueName(base = "video") {
    return `${base}-${crypto.randomBytes(4).toString("hex")}`;
}

async function saveBase64Video(base64, filepath) {
    const buffer = Buffer.from(base64, "base64");
    fs.writeFileSync(filepath, buffer);
}

async function overlayOnBG(videoFile, bgFile, outputFile, topCrop) {
    const cmd = `"${ffmpegPath}" -y -threads 1 -i "${bgImage}" -i "${videoFile}" -filter_complex "[0:v]scale=1080:1080[bg];[1:v]scale=800:800[vid];[bg][vid]overlay=(W-w)/2:${topCrop}:format=auto[out]" -map "[out]" -map 1:a -c:v libx264 -crf 23 -preset ultrafast -c:a mp3 -b:a 128k "${outputFile}"`;
    await run(cmd);
}

async function smartCrop(inputFile, outputFile, debug = false) {
    const probeCmd = `"${ffmpegPath}" -i "${inputFile}"`;
    const { stderr: probeData } = await run(probeCmd).catch(e => e);
    const dimMatch = probeData.match(/(\d+)x(\d+)/);
    const width = dimMatch ? Number(dimMatch[1]) : 0;
    const height = dimMatch ? Number(dimMatch[2]) : 0;

    const detectCmd = `"${ffmpegPath}" -i "${inputFile}" -vf "edgedetect=low=0.1:high=0.4,cropdetect=limit=10:round=2" -t 1 -f null -`;
    const { stderr } = await run(detectCmd);
    const match = stderr.match(/crop=(\d+):(\d+):(\d+):(\d+)/);
    
    let dW, dH, dX, dY;
    if (match) {
        [_, dW, dH, dX, dY] = match.map(Number);
        if (dY < 50 && dH > height * 0.9) { dY = Math.floor(height * 0.10); dH = Math.floor(height * 0.80); }
        dY = Math.max(0, dY - 15); dH = Math.min(height - dY, dH + 30);
    } else {
        dY = Math.floor(height * 0.20); dH = Math.floor(height * 0.60); dX = 0; dW = width;
    }

    const maxSide = Math.max(dW, dH);
    const filter = `crop=${dW}:${dH}:${dX}:${dY},pad=${maxSide}:${maxSide}:(ow-iw)/2:(oh-ih)/2:white`;

    if (debug) {
        const debugImg = path.join(DIRS.output, 'debug-linhas.png');
        await run(`"${ffmpegPath}" -y -i "${inputFile}" -ss 1 -vf "drawbox=x=${dX}:y=${dY}:w=${dW}:h=${dH}:color=red:t=5" -vframes 1 "${debugImg}"`);
    }

    await run(`"${ffmpegPath}" -y -threads 1 -i "${inputFile}" -vf "${filter}" -c:v libx264 -crf 23 -preset ultrafast -c:a copy "${outputFile}"`);
}

app.post("/process-video", async (req, res) => {
    const { data, top = 110, text1 = "back.png", isCut = false, debug = false } = req.body;
    if (!data) return res.status(400).json({ error: "sem dados" });

    const uniqueName = generateUniqueName();
    const inputFile = path.join(DIRS.temp, `${uniqueName}-in.mp4`);
    const croppedFile = path.join(DIRS.temp, `${uniqueName}-cr.mp4`);
    const finalFile = path.join(DIRS.output, `${uniqueName}-out.mp4`);
    const bgImage = path.join(DIRS.img, text1);

    try {
        await saveBase64Video(data, inputFile);
        let videoSource = inputFile;
        if (isCut) {
            await smartCrop(inputFile, croppedFile, debug);
            videoSource = croppedFile;
        }
        
        const cmdOverlay = `"${ffmpegPath}" -y -threads 1 -i "${bgImage}" -i "${videoSource}" -filter_complex "[0:v]scale=1080:1080[bg];[1:v]scale=800:800[vid];[bg][vid]overlay=(W-w)/2:${top}:format=auto[out]" -map "[out]" -map 1:a -c:v libx264 -crf 23 -preset ultrafast -c:a mp3 -b:a 128k "${finalFile}"`;
        await run(cmdOverlay);

        const finalBase64 = fs.readFileSync(finalFile).toString("base64");
        const url = `${req.protocol}://${req.get("host")}/output/${path.basename(finalFile)}`;
        
        [inputFile, croppedFile].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        return res.json({ url, base64: finalBase64 });
    } catch (e) {
        [inputFile, croppedFile, finalFile].forEach(f => { if (f && fs.existsSync(f)) fs.unlinkSync(f); });
        return res.status(500).send("Erro");
    }
});

app.post("/tucano", async (req, res) => {
    const { text = "", text1 = "", marginLeft = 20, top = 20, maxCharsPerLine = 31 } = req.body;
    const uniqueName = generateUniqueName("tucano");
    const tmpFrames = path.join(DIRS.temp, `${uniqueName}-f.mp4`);
    const tmpWithText = path.join(DIRS.temp, `${uniqueName}-t.mp4`);
    const finalFile = path.join(DIRS.output, `${uniqueName}-res.mp4`);
    const bgImage = path.join(DIRS.img, "backgroundtucano.png");
    const fontPath = path.join(DIRS.fonts, "HelveticaNeueMedium.otf");
    const audioFile = path.join(DIRS.audio, "tucano.mp3");

    function splitText(t, m) {
        const words = t.split(" ");
        const lines = [];
        let cur = "";
        for (const w of words) {
            if ((cur + " " + w).trim().length <= m) cur = (cur + " " + w).trim();
            else { if (cur) lines.push(cur); cur = w; }
        }
        if (cur) lines.push(cur);
        return lines;
    }

    try {
        await run(`"${ffmpegPath}" -y -threads 1 -loop 1 -i "${bgImage}" -t 15 -r 24 -c:v libx264 -preset ultrafast -pix_fmt yuv420p "${tmpFrames}"`);
        const texts = [];
        if (text.trim()) texts.push({ text, top, fontSize: 60 });
        if (text1.trim()) texts.push({ text: text1, top: top + 150, fontSize: 28 });

        if (texts.length > 0) {
            const filters = [];
            texts.forEach(t => {
                const lines = splitText(t.text, maxCharsPerLine);
                let lineY = t.top;
                lines.forEach(line => {
                    const esc = line.replace(/\\/g, "\\\\\\\\").replace(/'/g, "\\\\'").replace(/:/g, "\\:").replace(/,/g, "\\,");
                    filters.push(`drawtext=fontfile='${fontPath}':text='${esc}':x=${marginLeft}:y=${lineY}:fontsize=${t.fontSize}:fontcolor=white`);
                    lineY += t.fontSize + 10;
                });
            });
            await run(`"${ffmpegPath}" -y -threads 1 -i "${tmpFrames}" -vf "${filters.join(",")}" -c:v libx264 -crf 23 -preset ultrafast "${tmpWithText}"`);
        } else {
            fs.copyFileSync(tmpFrames, tmpWithText);
        }
        await run(`"${ffmpegPath}" -y -threads 1 -i "${tmpWithText}" -i "${audioFile}" -c:v copy -c:a aac -b:a 128k -t 15 "${finalFile}"`);
        
        const base64 = fs.readFileSync(finalFile).toString("base64");
        [tmpFrames, tmpWithText].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        return res.json({ url: `${req.protocol}://${req.get("host")}/output/${path.basename(finalFile)}`, base64 });
    } catch (e) {
        return res.status(500).send("Erro");
    }
});

app.listen(PORT);