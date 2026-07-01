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
app.use(express.json({ limit: '20mb' }));
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
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function safeFileId(value) {
  return cleanText(value || uuidv4(), 60).replace(/[^a-zA-Z0-9_-]/g, '');
}

function safeColor(value, fallback) {
  const v = String(value || '').trim();
  if (!v) return fallback;
  return v.replace(/[^a-zA-Z0-9#@.]/g, '');
}

function execFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 90000 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

function baseArgs(imageUrl, duration) {
  return ['-y', '-loop', '1', '-t', String(duration), '-i', imageUrl];
}

function outputArgs(outPath) {
  return [
    '-r', '24',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '28',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath
  ];
}

function buildLightFilter(data) {
  const bg = safeColor(data.bg_color, 'black');
  const primary = safeColor(data.primary_color, 'yellow');
  const accent = safeColor(data.accent_color, 'red');
  const text = safeColor(data.text_color, 'white');

  const brand = cleanText(data.brand_name || 'OFERTAS', 36).toUpperCase();
  const badge = cleanText(data.brand_badge || 'MAIS VENDIDO', 26).toUpperCase();
  const price = cleanText(data.preco || '', 48).toUpperCase();
  const oldPrice = cleanText(data.preco_original_text || '', 36).toUpperCase();
  const discount = cleanText(data.desconto || '', 28).toUpperCase();
  const comment = cleanText(data.comentario || `ID ${data.produto_id}`, 32).toUpperCase();

  const parts = [
    // Produto ocupa mais tela, sem zoompan pesado.
    `scale=1080:1240:force_original_aspect_ratio=decrease`,
    `pad=1080:1920:(ow-iw)/2:155:color=${bg}`,

    // Cabeçalho leve
    `drawbox=x=0:y=0:w=1080:h=150:color=${bg}@0.90:t=fill`,
    `drawbox=x=36:y=34:w=360:h=68:color=${primary}@1:t=fill`,
    `drawtext=text='${badge}':fontcolor=black:fontsize=34:x=62:y=51`,
    `drawtext=text='${brand}':fontcolor=${text}:fontsize=40:x=52:y=108`,

    // Selo desconto pequeno
    discount ? `drawbox=x=770:y=190:w=250:h=90:color=${accent}@0.94:t=fill` : null,
    discount ? `drawtext=text='${discount}':fontcolor=${text}:fontsize=40:x=805:y=217` : null,

    // Bloco de conversão
    `drawbox=x=0:y=1420:w=1080:h=500:color=${bg}@0.93:t=fill`,
    oldPrice ? `drawtext=text='${oldPrice}':fontcolor=gray:fontsize=36:x=(w-text_w)/2:y=1462` : null,
    `drawtext=text='${price}':fontcolor=${primary}:fontsize=84:x=(w-text_w)/2:y=1528`,
    `drawtext=text='👇 COMENTE':fontcolor=${text}:fontsize=52:x=(w-text_w)/2:y=1648`,
    `drawtext=text='${comment}':fontcolor=${primary}:fontsize=94:x=(w-text_w)/2:y=1720`,
    `drawtext=text='QUE EU TE MANDO O LINK':fontcolor=${text}:fontsize=34:x=(w-text_w)/2:y=1846`,
    `format=yuv420p`
  ];

  return parts.filter(Boolean).join(',');
}

async function buildWithBanner(data, outPath) {
  const bg = safeColor(data.bg_color, 'black');
  const primary = safeColor(data.primary_color, 'yellow');
  const accent = safeColor(data.accent_color, 'red');
  const text = safeColor(data.text_color, 'white');

  const price = cleanText(data.preco || '', 48).toUpperCase();
  const oldPrice = cleanText(data.preco_original_text || '', 36).toUpperCase();
  const discount = cleanText(data.desconto || '', 28).toUpperCase();
  const comment = cleanText(data.comentario || `ID ${data.produto_id}`, 32).toUpperCase();

  // Topo produto, bloco preço e rodapé banner.
  // Sem zoompan e sem filtros caros.
  const filter = [
    `[0:v]scale=1080:1280:force_original_aspect_ratio=decrease,pad=1080:1280:(ow-iw)/2:(oh-ih)/2:color=${bg}[prod]`,
    `[1:v]scale=1080:-1:force_original_aspect_ratio=decrease,crop=1080:min(230\\,ih):0:0[brand]`,
    `color=c=${bg}:s=1080x1920:d=${data.duration}[canvas]`,
    `[canvas][prod]overlay=0:70[tmp1]`,
    `[tmp1]drawbox=x=0:y=1360:w=1080:h=330:color=${bg}@0.94:t=fill,` +
      (discount ? `drawbox=x=52:y=1386:w=240:h=78:color=${accent}@0.94:t=fill,drawtext=text='${discount}':fontcolor=${text}:fontsize=38:x=82:y=1408,` : '') +
      (oldPrice ? `drawtext=text='${oldPrice}':fontcolor=gray:fontsize=34:x=(w-text_w)/2:y=1402,` : '') +
      `drawtext=text='${price}':fontcolor=${primary}:fontsize=78:x=(w-text_w)/2:y=1462,` +
      `drawtext=text='👇 COMENTE':fontcolor=${text}:fontsize=44:x=(w-text_w)/2:y=1556,` +
      `drawtext=text='${comment}':fontcolor=${primary}:fontsize=74:x=(w-text_w)/2:y=1606[tmp2]`,
    `[tmp2][brand]overlay=0:1690,format=yuv420p[out]`
  ].join(';');

  const args = [
    ...baseArgs(data.image_url, data.duration),
    '-loop', '1',
    '-t', String(data.duration),
    '-i', data.brand_banner_url,
    '-filter_complex', filter,
    '-map', '[out]',
    ...outputArgs(outPath)
  ];

  await execFfmpeg(args);
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'reels-engine-leve-otimizado',
    version: '2.1.0',
    public_base_url: PUBLIC_BASE_URL || null
  });
});

app.get('/templates', (req, res) => {
  res.json({
    ok: true,
    templates: [
      {
        key: 'premium_leve',
        description: 'Bonito, com baixo consumo de CPU, CTA forte e marca dinâmica.'
      }
    ]
  });
});

app.post('/create-reel', requireApiKey, async (req, res) => {
  const startedAt = Date.now();

  try {
    const body = req.body || {};
    const imageUrl = body.image_url;

    if (!imageUrl) {
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

    const produtoId = safeFileId(body.produto_id);
    const duration = Math.max(5, Math.min(Number(body.duration || 8), 10));
    const fileName = `reel_${produtoId}_${Date.now()}.mp4`;
    const outPath = path.join(OUTPUT_DIR, fileName);

    const data = {
      ...body,
      produto_id: produtoId,
      duration,
      comentario: cleanText(body.comentario || `ID ${produtoId}`, 32).toUpperCase()
    };

    console.log(`[create-reel] start produto=${produtoId} banner=${Boolean(data.brand_banner_url)}`);

    if (data.brand_banner_url) {
      await buildWithBanner(data, outPath);
    } else {
      const filter = buildLightFilter(data);
      const args = [
        ...baseArgs(data.image_url, data.duration),
        '-vf', filter,
        ...outputArgs(outPath)
      ];
      await execFfmpeg(args);
    }

    const videoUrl = `${PUBLIC_BASE_URL}/reels/${fileName}`;
    const elapsed_ms = Date.now() - startedAt;

    console.log(`[create-reel] done produto=${produtoId} ${elapsed_ms}ms ${videoUrl}`);

    return res.json({
      ok: true,
      produto_id: produtoId,
      template: 'premium_leve',
      comment_text: data.comentario,
      used_brand_banner: Boolean(data.brand_banner_url),
      video_url: videoUrl,
      filename: fileName,
      elapsed_ms
    });
  } catch (error) {
    console.error('[create-reel] error', error.message, error.stderr || '');

    return res.status(500).json({
      ok: false,
      error: 'VIDEO_CREATION_FAILED',
      message: error.message,
      details: error.stderr || null
    });
  }
});

app.listen(PORT, () => {
  console.log(`Reels Engine Leve running on port ${PORT}`);
  console.log(`Public base URL: ${PUBLIC_BASE_URL || '(not set)'}`);
});
