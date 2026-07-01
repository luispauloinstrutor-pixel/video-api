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

function clean(value, max = 80) {
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
    '-crf', '27',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath
  ];
}

function buildProFilter(data) {
  const bg = color(data.bg_color, 'black');
  const panel = color(data.panel_color, 'black');
  const yellow = color(data.primary_color, 'yellow');
  const accent = color(data.accent_color, 'red');
  const text = color(data.text_color, 'white');

  const brand = clean(data.brand_name || 'OFERTAS', 34).toUpperCase();
  const badge = clean(data.brand_badge || 'OFERTA DO DIA', 26).toUpperCase();
  const price = clean(data.preco || '', 45).toUpperCase();
  const old = clean(data.preco_original_text || '', 36).toUpperCase();
  const discount = clean(data.desconto || '', 28).toUpperCase();
  const idText = clean(data.comentario || `ID ${data.produto_id}`, 24).toUpperCase();

  // Layout:
  // 0-105: header fino
  // 105-1190: produto grande
  // 1190-1700: card preço/CTA bem legível
  // 1700-1920: banner/rodapé ou texto de marca
  return [
    `scale=1080:1085:force_original_aspect_ratio=decrease`,
    `pad=1080:1920:(ow-iw)/2:105:color=${bg}`,

    // header profissional
    `drawbox=x=0:y=0:w=1080:h=105:color=${bg}@1:t=fill`,
    `drawbox=x=34:y=24:w=345:h=58:color=${yellow}@1:t=fill`,
    `drawtext=text='${badge}':fontcolor=black:fontsize=32:x=58:y=37`,
    `drawtext=text='${brand}':fontcolor=${text}:fontsize=32:x=420:y=36`,

    // selo desconto no produto
    discount ? `drawbox=x=730:y=140:w=300:h=86:color=${accent}@0.95:t=fill` : null,
    discount ? `drawtext=text='${discount}':fontcolor=${text}:fontsize=44:x=770:y=164` : null,

    // painel central, não tão embaixo
    `drawbox=x=45:y=1195:w=990:h=505:color=${panel}@0.96:t=fill`,
    `drawbox=x=45:y=1195:w=990:h=6:color=${yellow}@1:t=fill`,

    // preço antigo e preço atual
    old ? `drawtext=text='${old}':fontcolor=gray:fontsize=38:x=(w-text_w)/2:y=1238` : null,
    `drawtext=text='${price}':fontcolor=${yellow}:fontsize=90:x=(w-text_w)/2:y=1300`,

    // CTA gigante legível
    `drawtext=text='👇 COMENTE':fontcolor=${text}:fontsize=58:x=(w-text_w)/2:y=1428`,
    `drawbox=x=270:y=1500:w=540:h=118:color=${yellow}@1:t=fill`,
    `drawtext=text='${idText}':fontcolor=black:fontsize=82:x=(w-text_w)/2:y=1520`,
    `drawtext=text='RECEBA O LINK NO DIRECT':fontcolor=${text}:fontsize=36:x=(w-text_w)/2:y=1640`,

    // rodapé simples se não usar banner
    `drawbox=x=0:y=1740:w=1080:h=180:color=${bg}@1:t=fill`,
    `drawtext=text='${brand}':fontcolor=${text}:fontsize=42:x=60:y=1800`,
    `drawtext=text='OFERTA VERIFICADA ✅':fontcolor=${text}:fontsize=34:x=650:y=1808`,
    `format=yuv420p`
  ].filter(Boolean).join(',');
}

async function buildWithBanner(data, outPath) {
  const bg = color(data.bg_color, 'black');
  const panel = color(data.panel_color, 'black');
  const yellow = color(data.primary_color, 'yellow');
  const accent = color(data.accent_color, 'red');
  const text = color(data.text_color, 'white');

  const badge = clean(data.brand_badge || 'OFERTA DO DIA', 26).toUpperCase();
  const price = clean(data.preco || '', 45).toUpperCase();
  const old = clean(data.preco_original_text || '', 36).toUpperCase();
  const discount = clean(data.desconto || '', 28).toUpperCase();
  const idText = clean(data.comentario || `ID ${data.produto_id}`, 24).toUpperCase();

  const filter = [
    `[0:v]scale=1080:1050:force_original_aspect_ratio=decrease,pad=1080:1050:(ow-iw)/2:(oh-ih)/2:color=${bg}[prod]`,
    `[1:v]scale=1080:-1:force_original_aspect_ratio=decrease,crop=1080:min(210\\,ih):0:0[banner]`,
    `color=c=${bg}:s=1080x1920:d=${data.duration}[canvas]`,
    `[canvas]drawbox=x=0:y=0:w=1080:h=105:color=${bg}@1:t=fill,drawbox=x=34:y=24:w=345:h=58:color=${yellow}@1:t=fill,drawtext=text='${badge}':fontcolor=black:fontsize=32:x=58:y=37[top]`,
    `[top][prod]overlay=0:105[tmp1]`,
    `[tmp1]` +
      (discount ? `drawbox=x=730:y=140:w=300:h=86:color=${accent}@0.95:t=fill,drawtext=text='${discount}':fontcolor=${text}:fontsize=44:x=770:y=164,` : '') +
      `drawbox=x=45:y=1190:w=990:h=500:color=${panel}@0.96:t=fill,drawbox=x=45:y=1190:w=990:h=6:color=${yellow}@1:t=fill,` +
      (old ? `drawtext=text='${old}':fontcolor=gray:fontsize=38:x=(w-text_w)/2:y=1232,` : '') +
      `drawtext=text='${price}':fontcolor=${yellow}:fontsize=88:x=(w-text_w)/2:y=1294,` +
      `drawtext=text='👇 COMENTE':fontcolor=${text}:fontsize=56:x=(w-text_w)/2:y=1422,` +
      `drawbox=x=270:y=1492:w=540:h=118:color=${yellow}@1:t=fill,` +
      `drawtext=text='${idText}':fontcolor=black:fontsize=82:x=(w-text_w)/2:y=1512,` +
      `drawtext=text='RECEBA O LINK NO DIRECT':fontcolor=${text}:fontsize=36:x=(w-text_w)/2:y=1630[tmp2]`,
    `[tmp2][banner]overlay=0:1710,format=yuv420p[out]`
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
    service: 'reels-engine-pro-v3',
    version: '3.0.0',
    public_base_url: PUBLIC_BASE_URL
  });
});

app.post('/create-reel', requireApiKey, async (req, res) => {
  const start = Date.now();

  try {
    const body = req.body || {};
    if (!body.image_url) {
      return res.status(400).json({ ok:false, error:'MISSING_IMAGE_URL' });
    }

    if (!PUBLIC_BASE_URL) {
      return res.status(500).json({ ok:false, error:'MISSING_PUBLIC_BASE_URL' });
    }

    const produtoId = safeId(body.produto_id);
    const duration = Math.max(6, Math.min(Number(body.duration || 8), 10));
    const fileName = `pro_${produtoId}_${Date.now()}.mp4`;
    const outPath = path.join(OUTPUT_DIR, fileName);

    const data = {
      ...body,
      produto_id: produtoId,
      duration,
      comentario: clean(body.comentario || `ID ${produtoId}`, 24).toUpperCase()
    };

    console.log(`[create-reel] start id=${produtoId} banner=${Boolean(data.brand_banner_url)}`);

    if (data.brand_banner_url) {
      await buildWithBanner(data, outPath);
    } else {
      const filter = buildProFilter(data);
      const args = [
        '-y',
        '-loop', '1',
        '-t', String(duration),
        '-i', data.image_url,
        '-vf', filter,
        ...outputArgs(outPath)
      ];
      await ffmpeg(args);
    }

    const videoUrl = `${PUBLIC_BASE_URL}/reels/${fileName}`;

    console.log(`[create-reel] done id=${produtoId} ${Date.now() - start}ms`);

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

app.listen(PORT, () => {
  console.log(`Reels Engine Pro v3 running on port ${PORT}`);
});
