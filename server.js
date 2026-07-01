const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const API_KEY = process.env.API_KEY || '';
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, 'public', 'reels');
const TMP_DIR = process.env.TMP_DIR || path.join(__dirname, 'tmp');

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use('/reels', express.static(OUTPUT_DIR));

fs.ensureDirSync(OUTPUT_DIR);
fs.ensureDirSync(TMP_DIR);

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();

  const headerKey = req.headers['x-api-key'];
  if (headerKey !== API_KEY) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHORIZED',
      message: 'Invalid or missing x-api-key'
    });
  }

  next();
}

function cleanText(value, max = 80) {
  return String(value || '')
    .replace(/\r?\n/g, ' ')
    .replace(/[\\"]/g, '')
    .replace(/:/g, ' -')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function execFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'media-service-achei-da-hora',
    public_base_url: PUBLIC_BASE_URL || null
  });
});

app.post('/create-reel', requireApiKey, async (req, res) => {
  try {
    const {
      produto_id,
      image_url,
      titulo,
      preco,
      comentario,
      desconto
    } = req.body || {};

    if (!image_url) {
      return res.status(400).json({
        ok: false,
        error: 'MISSING_IMAGE_URL',
        message: 'image_url is required'
      });
    }

    if (!PUBLIC_BASE_URL) {
      return res.status(500).json({
        ok: false,
        error: 'MISSING_PUBLIC_BASE_URL',
        message: 'Set PUBLIC_BASE_URL environment variable'
      });
    }

    const safeId = cleanText(produto_id || uuidv4(), 40).replace(/[^a-zA-Z0-9_-]/g, '');
    const fileName = `oferta_${safeId}_${Date.now()}.mp4`;
    const outPath = path.join(OUTPUT_DIR, fileName);

    const tituloVideo = cleanText(titulo, 58);
    const precoVideo = cleanText(preco || '', 45);
    const comentarioVideo = cleanText(comentario || `COMENTE ${safeId}`, 45);
    const descontoVideo = cleanText(desconto || '', 40);

    const filters = [
      "scale=1080:1500:force_original_aspect_ratio=decrease",
      "pad=1080:1920:(ow-iw)/2:130:color=black",
      "drawbox=x=0:y=0:w=1080:h=130:color=black@0.75:t=fill",
      "drawtext=text='ACHEI DA HORA':fontcolor=white:fontsize=54:x=(w-text_w)/2:y=38",
      "drawbox=x=0:y=1510:w=1080:h=410:color=black@0.88:t=fill",
      `drawtext=text='${precoVideo}':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=1570`,
      descontoVideo ? `drawtext=text='${descontoVideo}':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=1660` : null,
      `drawtext=text='${comentarioVideo}':fontcolor=white:fontsize=62:x=(w-text_w)/2:y=1735`,
      "drawtext=text='QUE EU TE MANDO O LINK':fontcolor=white:fontsize=38:x=(w-text_w)/2:y=1815",
      "format=yuv420p"
    ].filter(Boolean).join(',');

    const args = [
      '-y',
      '-loop', '1',
      '-t', '9',
      '-i', image_url,
      '-vf', filters,
      '-r', '30',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outPath
    ];

    await execFfmpeg(args);

    const videoUrl = `${PUBLIC_BASE_URL}/reels/${fileName}`;

    return res.json({
      ok: true,
      produto_id: safeId,
      video_url: videoUrl,
      filename: fileName
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'VIDEO_CREATION_FAILED',
      message: error.message,
      details: error.stderr || null
    });
  }
});

app.listen(PORT, () => {
  console.log(`Media Service running on port ${PORT}`);
  console.log(`Public base URL: ${PUBLIC_BASE_URL || '(not set)'}`);
});
