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

const SERVICE_NAME = 'reels-engine-premium';
const VERSION = '5.0.0';

const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 120000);
const MAX_FFMPEG_JOBS = Number(process.env.MAX_FFMPEG_JOBS || 1);

let activeFFmpegJobs = 0;

fs.ensureDirSync(OUTPUT_DIR);

app.disable('x-powered-by');

app.use(cors());
app.use(express.json({ limit: '3mb' }));

app.use('/reels', express.static(OUTPUT_DIR, {
  maxAge: '7d',
  immutable: true
}));

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();

  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHORIZED'
    });
  }

  next();
}

function acquireJobSlot() {
  if (activeFFmpegJobs >= MAX_FFMPEG_JOBS) return false;
  activeFFmpegJobs++;
  return true;
}

function releaseJobSlot() {
  activeFFmpegJobs = Math.max(0, activeFFmpegJobs - 1);
}

function cleanText(value, max = 90) {
  return String(value || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function ffText(value, max = 90) {
  return cleanText(value, max)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/;/g, '\\;');
}

function safeId(value) {
  const cleaned = cleanText(value || uuidv4(), 80).replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned || uuidv4().replace(/-/g, '');
}

function extractId(value, fallback) {
  const s = String(value || '');
  const m = s.match(/(?:id\s*)?(\d{1,12})/i);

  if (m) return m[1];

  const fallbackDigits = String(fallback || '').replace(/\D/g, '');
  return fallbackDigits || '000';
}

function color(value, fallback) {
  const raw = String(value || fallback).trim();

  if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
    return `0x${raw.slice(1)}`;
  }

  if (/^0x[0-9a-fA-F]{6}$/.test(raw)) {
    return raw;
  }

  if (/^[a-zA-Z]{3,24}$/.test(raw)) {
    return raw.toLowerCase();
  }

  return fallback;
}

function fontSizeForPrice(price) {
  const len = String(price || '').length;

  if (len >= 18) return 70;
  if (len >= 15) return 78;
  if (len >= 12) return 88;

  return 104;
}

function validateUrl(value, fieldName) {
  const raw = String(value || '').trim();

  if (!raw) {
    const err = new Error(`${fieldName}_REQUIRED`);
    err.statusCode = 400;
    err.publicCode = `${fieldName}_REQUIRED`;
    throw err;
  }

  if (raw.length > 2048) {
    const err = new Error(`${fieldName}_TOO_LONG`);
    err.statusCode = 400;
    err.publicCode = `${fieldName}_TOO_LONG`;
    throw err;
  }

  let parsed;

  try {
    parsed = new URL(raw);
  } catch {
    const err = new Error(`${fieldName}_INVALID_URL`);
    err.statusCode = 400;
    err.publicCode = `${fieldName}_INVALID_URL`;
    throw err;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const err = new Error(`${fieldName}_INVALID_PROTOCOL`);
    err.statusCode = 400;
    err.publicCode = `${fieldName}_INVALID_PROTOCOL`;
    throw err;
  }

  return parsed.toString();
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-nostdin', ...args],
      {
        timeout: FFMPEG_TIMEOUT_MS,
        maxBuffer: 12 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          return reject(err);
        }

        resolve({ stdout, stderr });
      }
    );
  });
}

function outputArgs(outPath) {
  return [
    '-r', '24',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '24',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath
  ];
}

function buildPremiumFilter(data, hasBanner) {
  const duration = Number(data.duration || 8);

  const bg = color(data.bg_color, '0x070707');
  const yellow = color(data.primary_color, '0xFFE600');
  const accent = color(data.accent_color, '0xFF2433');
  const text = color(data.text_color, 'white');
  const muted = color(data.muted_color, '0xA8A8A8');
  const card = color(data.panel_color, '0x111111');

  const brand = ffText(data.brand_name || 'ACHEI DA HORA', 32).toUpperCase();
  const badge = ffText(data.brand_badge || 'OFERTA RELÂMPAGO', 30).toUpperCase();

  const priceRaw = cleanText(data.preco || data.price || 'OFERTA ESPECIAL', 42).toUpperCase();
  const price = ffText(priceRaw, 42);

  const old = ffText(data.preco_original_text || data.preco_original || '', 38).toUpperCase();
  const discount = ffText(data.desconto || data.discount || '', 28).toUpperCase();

  const idNumber = ffText(extractId(data.comentario, data.produto_id), 14);
  const priceFontSize = fontSizeForPrice(priceRaw);

  const productHeight = hasBanner ? 800 : 850;
  const productY = hasBanner ? 188 : 205;

  const cardY = hasBanner ? 1015 : 1060;
  const cardH = hasBanner ? 660 : 670;

  const ctaY = hasBanner ? 1475 : 1535;
  const subY = hasBanner ? 1626 : 1688;

  const footerY = hasBanner ? 1695 : 1845;
  const bannerY = 1750;

  const productInput = `[0:v]scale=960:${productHeight}:force_original_aspect_ratio=decrease,format=rgba[prod]`;

  const bannerInput = hasBanner
    ? `[1:v]scale=1080:-1:force_original_aspect_ratio=increase,crop=1080:min(165\\,ih):0:0[banner]`
    : null;

  const base = [
    `drawbox=x=0:y=0:w=1080:h=1920:color=${bg}@1:t=fill`,

    // Profundidade visual
    `drawbox=x=0:y=0:w=1080:h=155:color=black@0.65:t=fill`,
    `drawbox=x=-120:y=120:w=1320:h=76:color=${yellow}@0.13:t=fill`,
    `drawbox=x=0:y=900:w=1080:h=1020:color=black@0.30:t=fill`,

    // Topo
    `drawbox=x=44:y=42:w=468:h=78:color=${yellow}@1:t=fill`,
    `drawtext=text='${badge}':fontcolor=black:fontsize=35:x=72:y=62`,
    `drawtext=text='${brand}':fontcolor=${text}:fontsize=30:x=548:y=65`,

    // Micro selo
    `drawbox=x=44:y=144:w=212:h=46:color=${accent}@1:t=fill`,
    `drawtext=text='ACHADO':fontcolor=white:fontsize=27:x=74:y=155`,

    // Barra discreta
    `drawbox=x=284:y=165:w=752:h=3:color=${yellow}@0.65:t=fill`
  ].join(',');

  const cardDraw = [
    // Sombra do card
    `drawbox=x=42:y=${cardY + 18}:w=996:h=${cardH}:color=black@0.42:t=fill`,

    // Card principal
    `drawbox=x=58:y=${cardY}:w=964:h=${cardH}:color=${card}@0.98:t=fill`,
    `drawbox=x=58:y=${cardY}:w=964:h=8:color=${yellow}@1:t=fill`,

    // Desconto
    discount
      ? `drawbox=x=690:y=${cardY + 36}:w=292:h=74:color=${accent}@1:t=fill`
      : null,
    discount
      ? `drawtext=text='${discount}':fontcolor=white:fontsize=39:x=690+(292-text_w)/2:y=${cardY + 56}`
      : null,

    // Headline
    `drawtext=text='PREÇO DE HOJE':fontcolor=${yellow}:fontsize=39:x=92:y=${cardY + 55}`,

    // Preço antigo
    old
      ? `drawtext=text='${old}':fontcolor=${muted}:fontsize=35:x=(w-text_w)/2:y=${cardY + 142}`
      : null,

    // Preço principal
    `drawtext=text='${price}':fontcolor=${yellow}:fontsize=${priceFontSize}:x=(w-text_w)/2:y=${cardY + 205}`,

    // Urgência honesta
    `drawtext=text='PREÇO PODE MUDAR A QUALQUER MOMENTO':fontcolor=${text}:fontsize=31:x=(w-text_w)/2:y=${cardY + 335}`,

    // CTA forte
    `drawbox=x=118:y=${ctaY}:w=844:h=130:color=${yellow}@1:t=fill`,
    `drawtext=text='COMENTE ID ${idNumber}':fontcolor=black:fontsize=62:x=(w-text_w)/2:y=${ctaY + 34}`,

    // Explicação do CTA
    `drawtext=text='RECEBA O LINK NO DIRECT':fontcolor=${text}:fontsize=38:x=(w-text_w)/2:y=${subY}`,

    // Rodapé de confiança
    `drawtext=text='OFERTA VERIFICADA':fontcolor=${muted}:fontsize=28:x=66:y=${footerY}`,
    `drawtext=text='${brand}':fontcolor=${muted}:fontsize=28:x=w-text_w-66:y=${footerY}`
  ].filter(Boolean).join(',');

  const filters = [
    productInput,
    bannerInput,
    `color=c=${bg}:s=1080x1920:d=${duration}[canvas]`,
    `[canvas]${base}[base]`,
    `[base][prod]overlay=(W-w)/2:${productY}[stage1]`,
    `[stage1]${cardDraw}[stage2]`,
    hasBanner
      ? `[stage2][banner]overlay=0:${bannerY},format=yuv420p[out]`
      : `[stage2]format=yuv420p[out]`
  ].filter(Boolean);

  return filters.join(';');
}

async function buildReel(data, outPath) {
  const hasBanner = Boolean(data.brand_banner_url);
  const filter = buildPremiumFilter(data, hasBanner);

  const args = [
    '-y',
    '-loop', '1',
    '-t', String(data.duration),
    '-i', data.image_url
  ];

  if (hasBanner) {
    args.push(
      '-loop', '1',
      '-t', String(data.duration),
      '-i', data.brand_banner_url
    );
  }

  args.push(
    '-filter_complex', filter,
    '-map', '[out]',
    ...outputArgs(outPath)
  );

  await ffmpeg(args);
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    version: VERSION,
    public_base_url: PUBLIC_BASE_URL,
    output_dir: OUTPUT_DIR,
    active_jobs: activeFFmpegJobs,
    max_jobs: MAX_FFMPEG_JOBS
  });
});

app.post('/create-reel', requireApiKey, async (req, res) => {
  const start = Date.now();

  if (!acquireJobSlot()) {
    return res.status(429).json({
      ok: false,
      error: 'SERVER_BUSY',
      message: 'Já existe uma geração de vídeo em andamento. Tente novamente em alguns segundos.'
    });
  }

  try {
    const body = req.body || {};

    if (!PUBLIC_BASE_URL) {
      return res.status(500).json({
        ok: false,
        error: 'MISSING_PUBLIC_BASE_URL'
      });
    }

    const imageUrl = validateUrl(body.image_url, 'IMAGE_URL');

    const bannerUrl = body.brand_banner_url
      ? validateUrl(body.brand_banner_url, 'BRAND_BANNER_URL')
      : '';

    const produtoId = safeId(body.produto_id);
    const duration = Math.max(6, Math.min(Number(body.duration || 8), 10));

    const fileName = `premium_${produtoId}_${Date.now()}.mp4`;
    const outPath = path.join(OUTPUT_DIR, fileName);

    const data = {
      ...body,
      image_url: imageUrl,
      brand_banner_url: bannerUrl,
      produto_id: produtoId,
      duration,
      comentario: body.comentario || `ID ${produtoId}`,

      // Defaults visuais premium
      brand_name: body.brand_name || 'ACHEI DA HORA',
      brand_badge: body.brand_badge || 'OFERTA RELÂMPAGO',

      bg_color: body.bg_color || '0x070707',
      primary_color: body.primary_color || '0xFFE600',
      accent_color: body.accent_color || '0xFF2433',
      text_color: body.text_color || 'white',
      muted_color: body.muted_color || '0xA8A8A8',
      panel_color: body.panel_color || '0x111111'
    };

    console.log(`[create-reel] start id=${produtoId} banner=${Boolean(data.brand_banner_url)} duration=${duration}`);

    await buildReel(data, outPath);

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

    res.status(err.statusCode || 500).json({
      ok: false,
      error: err.publicCode || 'VIDEO_CREATION_FAILED',
      message: err.statusCode ? err.message : 'Falha ao criar vídeo.',
      elapsed_ms: Date.now() - start
    });
  } finally {
    releaseJobSlot();
  }
});

app.delete('/reels', requireApiKey, async (req, res) => {
  const files = await fs.readdir(OUTPUT_DIR).catch(() => []);
  let deleted = 0;

  for (const file of files) {
    if (!file.endsWith('.mp4')) continue;

    await fs.remove(path.join(OUTPUT_DIR, file));
    deleted++;
  }

  res.json({
    ok: true,
    deleted
  });
});

app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} v${VERSION} running on port ${PORT}`);
});
