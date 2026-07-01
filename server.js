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

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use('/reels', express.static(OUTPUT_DIR));
fs.ensureDirSync(OUTPUT_DIR);

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ ok:false, error:'UNAUTHORIZED' });
  }
  next();
}

function clean(value, max = 90) {
  return String(value || '')
    .replace(/\r?\n/g, ' ')
    .replace(/[\\":']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function safeId(value) {
  return clean(value || uuidv4(), 60).replace(/[^a-zA-Z0-9_-]/g, '');
}

function extractId(value, fallback) {
  const s = String(value || '');
  const m = s.match(/(?:id\s*)?(\d{1,10})/i);
  return m ? m[1] : String(fallback || '').replace(/\D/g, '');
}

function color(value, fallback) {
  return String(value || fallback).replace(/[^a-zA-Z0-9#@.]/g, '');
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 90000 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

function outputArgs(outPath) {
  return [
    '-r', '24',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '26',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath
  ];
}

function buildNoBannerFilter(data) {
  const bg = color(data.bg_color, 'black');
  const yellow = color(data.primary_color, 'yellow');
  const accent = color(data.accent_color, 'red');
  const text = color(data.text_color, 'white');
  const card = color(data.panel_color, '0x111111');

  const brand = clean(data.brand_name || 'OFERTAS', 32).toUpperCase();
  const badge = clean(data.brand_badge || 'OFERTA DO DIA', 24).toUpperCase();
  const price = clean(data.preco || '', 42).toUpperCase();
  const old = clean(data.preco_original_text || '', 34).toUpperCase();
  const discount = clean(data.desconto || '', 26).toUpperCase();
  const idNumber = extractId(data.comentario, data.produto_id);

  return [
    // Fundo + produto grande
    `scale=1080:1130:force_original_aspect_ratio=decrease`,
    `pad=1080:1920:(ow-iw)/2:105:color=${bg}`,

    // Header limpo
    `drawbox=x=0:y=0:w=1080:h=105:color=${bg}@1:t=fill`,
    `drawbox=x=38:y=24:w=330:h=56:color=${yellow}@1:t=fill`,
    `drawtext=text='${badge}':fontcolor=black:fontsize=30:x=62:y=38`,
    `drawtext=text='${brand}':fontcolor=${text}:fontsize=30:x=405:y=38`,

    // Selo de desconto pequeno
    discount ? `drawbox=x=760:y=128:w=270:h=76:color=${accent}@0.95:t=fill` : null,
    discount ? `drawtext=text='${discount}':fontcolor=${text}:fontsize=38:x=795:y=148` : null,

    // Linha divisória elegante
    `drawbox=x=60:y=1245:w=960:h=5:color=${yellow}@1:t=fill`,

    // Card de conversão acima do rodapé
    `drawbox=x=70:y=1280:w=940:h=440:color=${card}@0.97:t=fill`,
    old ? `drawtext=text='${old}':fontcolor=gray:fontsize=34:x=(w-text_w)/2:y=1328` : null,
    `drawtext=text='${price}':fontcolor=${yellow}:fontsize=82:x=(w-text_w)/2:y=1388`,

    // CTA correto: COMENTE / ID 347
    `drawtext=text='COMENTE':fontcolor=${text}:fontsize=52:x=(w-text_w)/2:y=1504`,
    `drawbox=x=285:y=1572:w=510:h=108:color=${yellow}@1:t=fill`,
    `drawtext=text='ID ${idNumber}':fontcolor=black:fontsize=78:x=(w-text_w)/2:y=1590`,
    `drawtext=text='RECEBA O LINK NO DIRECT':fontcolor=${text}:fontsize=34:x=(w-text_w)/2:y=1688`,

    // Rodapé discreto, sem competir
    `drawtext=text='${brand}':fontcolor=gray:fontsize=28:x=60:y=1830`,
    `drawtext=text='OFERTA VERIFICADA':fontcolor=gray:fontsize=28:x=720:y=1830`,
    `format=yuv420p`
  ].filter(Boolean).join(',');
}

async function buildWithBanner(data, outPath) {
  const bg = color(data.bg_color, 'black');
  const yellow = color(data.primary_color, 'yellow');
  const accent = color(data.accent_color, 'red');
  const text = color(data.text_color, 'white');
  const card = color(data.panel_color, '0x111111');

  const badge = clean(data.brand_badge || 'OFERTA DO DIA', 24).toUpperCase();
  const price = clean(data.preco || '', 42).toUpperCase();
  const old = clean(data.preco_original_text || '', 34).toUpperCase();
  const discount = clean(data.desconto || '', 26).toUpperCase();
  const idNumber = extractId(data.comentario, data.produto_id);

  const filter = [
    `[0:v]scale=1080:1110:force_original_aspect_ratio=decrease,pad=1080:1110:(ow-iw)/2:(oh-ih)/2:color=${bg}[prod]`,
    `[1:v]scale=1080:-1:force_original_aspect_ratio=decrease,crop=1080:min(190\\,ih):0:0[banner]`,
    `color=c=${bg}:s=1080x1920:d=${data.duration}[canvas]`,

    // Header
    `[canvas]drawbox=x=0:y=0:w=1080:h=105:color=${bg}@1:t=fill,` +
      `drawbox=x=38:y=24:w=330:h=56:color=${yellow}@1:t=fill,` +
      `drawtext=text='${badge}':fontcolor=black:fontsize=30:x=62:y=38[top]`,

    `[top][prod]overlay=0:105[tmp1]`,

    // Conversão
    `[tmp1]` +
      (discount ? `drawbox=x=760:y=128:w=270:h=76:color=${accent}@0.95:t=fill,drawtext=text='${discount}':fontcolor=${text}:fontsize=38:x=795:y=148,` : '') +
      `drawbox=x=60:y=1245:w=960:h=5:color=${yellow}@1:t=fill,` +
      `drawbox=x=70:y=1280:w=940:h=440:color=${card}@0.97:t=fill,` +
      (old ? `drawtext=text='${old}':fontcolor=gray:fontsize=34:x=(w-text_w)/2:y=1328,` : '') +
      `drawtext=text='${price}':fontcolor=${yellow}:fontsize=82:x=(w-text_w)/2:y=1388,` +
      `drawtext=text='COMENTE':fontcolor=${text}:fontsize=52:x=(w-text_w)/2:y=1504,` +
      `drawbox=x=285:y=1572:w=510:h=108:color=${yellow}@1:t=fill,` +
      `drawtext=text='ID ${idNumber}':fontcolor=black:fontsize=78:x=(w-text_w)/2:y=1590,` +
      `drawtext=text='RECEBA O LINK NO DIRECT':fontcolor=${text}:fontsize=34:x=(w-text_w)/2:y=1688[tmp2]`,

    `[tmp2][banner]overlay=0:1730,format=yuv420p[out]`
  ].join(';');

  const args = [
    '-y',
    '-loop', '1',
    '-t', String(data.duration),
    '-i', data.image_url,
    '-loop', '1',
    '-t', String(data.duration),
    '-i', data.brand_banner_url,
    '-filter_complex', filter,
    '-map', '[out]',
    ...outputArgs(outPath)
  ];

  await ffmpeg(args);
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'reels-engine-pro-v4',
    version: '4.0.0',
    public_base_url: PUBLIC_BASE_URL
  });
});

app.post('/create-reel', requireApiKey, async (req, res) => {
  const start = Date.now();

  try {
    const body = req.body || {};
    if (!body.image_url) return res.status(400).json({ ok:false, error:'MISSING_IMAGE_URL' });
    if (!PUBLIC_BASE_URL) return res.status(500).json({ ok:false, error:'MISSING_PUBLIC_BASE_URL' });

    const produtoId = safeId(body.produto_id);
    const duration = Math.max(6, Math.min(Number(body.duration || 8), 10));
    const fileName = `pro_v4_${produtoId}_${Date.now()}.mp4`;
    const outPath = path.join(OUTPUT_DIR, fileName);

    const data = {
      ...body,
      produto_id: produtoId,
      duration,
      comentario: body.comentario || `ID ${produtoId}`
    };

    console.log(`[create-reel] start id=${produtoId} banner=${Boolean(data.brand_banner_url)}`);

    if (data.brand_banner_url) {
      await buildWithBanner(data, outPath);
    } else {
      const filter = buildNoBannerFilter(data);
      await ffmpeg([
        '-y',
        '-loop', '1',
        '-t', String(duration),
        '-i', data.image_url,
        '-vf', filter,
        ...outputArgs(outPath)
      ]);
    }

    const videoUrl = `${PUBLIC_BASE_URL}/reels/${fileName}`;

    res.json({
      ok: true,
      produto_id: produtoId,
      video_url: videoUrl,
      filename: fileName,
      elapsed_ms: Date.now() - start
    });
  } catch (err) {
    console.error('[create-reel] error', err.message, err.stderr || '');
    res.status(500).json({
      ok:false,
      error:'VIDEO_CREATION_FAILED',
      message: err.message,
      details: err.stderr || null
    });
  }
});

app.delete('/reels', requireApiKey, async (req, res) => {
  const files = await fs.readdir(OUTPUT_DIR).catch(() => []);
  let deleted = 0;
  for (const file of files) {
    if (file.endsWith('.mp4')) {
      await fs.remove(path.join(OUTPUT_DIR, file));
      deleted++;
    }
  }
  res.json({ ok:true, deleted });
});

app.listen(PORT, () => console.log(`Reels Engine Pro v4 running on port ${PORT}`));
