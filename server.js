const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');

// ==========================================
// CONFIGURAÇÕES E CONSTANTES
// ==========================================
const app = express();

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const API_KEY = process.env.API_KEY || '';
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, 'public', 'reels');

const SERVICE_NAME = 'reels-engine-professional';
const VERSION = '8.0.0';

const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 120000);
const MAX_FFMPEG_JOBS = Number(process.env.MAX_FFMPEG_JOBS || 1);

let activeFFmpegJobs = 0;

// Inicialização do ambiente
fs.ensureDirSync(OUTPUT_DIR);

// ==========================================
// MIDDLEWARES DE CONFIGURAÇÃO
// ==========================================
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '3mb' }));

app.use('/reels', express.static(OUTPUT_DIR, {
  maxAge: '7d',
  immutable: true
}));

// Middlewares de Segurança
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

// ==========================================
// GERENCIADOR DE FILA (JOBS)
// ==========================================
function acquireJobSlot() {
  if (activeFFmpegJobs >= MAX_FFMPEG_JOBS) return false;
  activeFFmpegJobs++;
  return true;
}

function releaseJobSlot() {
  activeFFmpegJobs = Math.max(0, activeFFmpegJobs - 1);
}

// ==========================================
// FUNÇÕES UTILITÁRIAS DE TRATAMENTO
// ==========================================
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

  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return `0x${raw.slice(1)}`;
  if (/^0x[0-9a-fA-F]{6}$/.test(raw)) return raw;
  if (/^[a-zA-Z]{3,24}$/.test(raw)) return raw.toLowerCase();

  return fallback;
}

function fontSizeForPrice(price) {
  const len = String(price || '').length;
  if (len >= 24) return 54;
  if (len >= 21) return 60;
  if (len >= 18) return 68;
  if (len >= 15) return 78;
  if (len >= 12) return 88;
  return 104;
}

function validateUrl(value, fieldName) {
  const raw = String(value || '').trim();

  const createError = (code, message) => {
    const err = new Error(message);
    err.statusCode = 400;
    err.publicCode = code;
    return err;
  };

  if (!raw) throw createError(`${fieldName}_REQUIRED`, `${fieldName}_REQUIRED`);
  if (raw.length > 2048) throw createError(`${fieldName}_TOO_LONG`, `${fieldName}_TOO_LONG`);

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw createError(`${fieldName}_INVALID_URL`, `${fieldName}_INVALID_URL`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw createError(`${fieldName}_INVALID_PROTOCOL`, `${fieldName}_INVALID_PROTOCOL`);
  }

  return parsed.toString();
}

// ==========================================
// MOTOR DE FILTROS E CORAÇÃO FFmpeg
// ==========================================
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-nostdin', ...args],
      {
        timeout: FFMPEG_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024
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
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath
  ];
}

function buildProfessionalFilter(data, hasBanner) {
  const duration = Number(data.duration || 8);

  // Mapeamento de Paleta de Cores
  const bg = color(data.bg_color, '0x050505');
  const yellow = color(data.primary_color, '0xFFE600');
  const goldSoft = color(data.secondary_color, '0xD6B84A');
  const accent = color(data.accent_color, '0xD92525');
  const text = color(data.text_color, 'white');
  const muted = color(data.muted_color, '0xBEBEBE');
  const card = color(data.panel_color, '0x101010');

  // Tratamento de Textos
  const brand = ffText(data.brand_name || 'ACHEI DA HORA', 34).toUpperCase();
  const badge = ffText(data.brand_badge || 'OFERTA ESPECIAL', 30).toUpperCase();
  const priceRaw = cleanText(data.preco || data.price || 'OFERTA ESPECIAL', 42).toUpperCase();
  const price = ffText(priceRaw, 42);
  const old = ffText(data.preco_original_text || data.preco_original || '', 38).toUpperCase();
  const discount = ffText(data.desconto || data.discount || '', 24).toUpperCase();
  const idNumber = ffText(extractId(data.comentario, data.produto_id), 14);
  const priceFontSize = fontSizeForPrice(priceRaw);

  // Posicionamento Dinâmico de Elementos
  const productMaxH = hasBanner ? 800 : 870;
  const productY = hasBanner ? 200 : 210;
  const cardY = hasBanner ? 1040 : 1100;
  const cardH = hasBanner ? 650 : 660;
  const commentY = hasBanner ? 1458 : 1520;
  const idBoxY = hasBanner ? 1518 : 1582;
  const subY = hasBanner ? 1660 : 1727;
  const footerY = hasBanner ? 1715 : 1850;
  const bannerY = 1760;

  // Renderização condicional de sub-filtros de string
  const discountFilter = discount
    ? `drawbox=x=716:y=${cardY + 34}:w=266:h=70:color=${accent}@0.96:t=fill,` +
      `drawtext=text='${discount}':fontcolor=white:fontsize=36:x=716+(266-text_w)/2:y=${cardY + 53}:shadowcolor=black@0.40:shadowx=2:shadowy=2,`
    : '';

  const oldPriceFilter = old
    ? `drawtext=text='${old}':fontcolor=${muted}:fontsize=33:x=(w-text_w)/2:y=${cardY + 136}:shadowcolor=black@0.65:shadowx=2:shadowy=2,`
    : '';

  const filters = [
    `[0:v]split=2[bgsrc][prodsrc]`,
    `[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=26:luma_power=2,eq=brightness=-0.40:saturation=1.08:contrast=1.10[bgblur]`,
    `[prodsrc]scale=940:${productMaxH}:force_original_aspect_ratio=decrease,format=rgba[prod]`,
    `color=c=${yellow}@0.08:s=1260x56:d=${duration},format=rgba,rotate=-0.10:c=none:ow=rotw(-0.10):oh=roth(-0.10)[line1]`,
    `color=c=white@0.045:s=1180x34:d=${duration},format=rgba,rotate=-0.10:c=none:ow=rotw(-0.10):oh=roth(-0.10)[line2]`,
    hasBanner ? `[1:v]scale=1080:-1:force_original_aspect_ratio=increase,crop=1080:min(150\\,ih):0:0[banner]` : null,
    
    `[bgblur][line1]overlay=x=-120:y=188:shortest=1[bg1]`,
    `[bg1][line2]overlay=x=-90:y=302:shortest=1[bg2]`,
    `[bg2]drawbox=x=0:y=0:w=1080:h=1920:color=${bg}@0.42:t=fill[base0]`,
    
    `[base0]` +
      `drawbox=x=0:y=0:w=1080:h=150:color=black@0.58:t=fill,` +
      `drawbox=x=46:y=44:w=420:h=72:color=${yellow}@1:t=fill,` +
      `drawtext=text='${badge}':fontcolor=black:fontsize=33:x=74:y=62,` +
      `drawtext=text='${brand}':fontcolor=${text}:fontsize=31:x=520:y=64:shadowcolor=black@0.75:shadowx=2:shadowy=2,` +
      `drawbox=x=46:y=144:w=988:h=3:color=${yellow}@0.65:t=fill[base1]`,
      
    `[base1]` +
      `drawbox=x=100:y=${productY + 70}:w=880:h=${productMaxH - 110}:color=black@0.20:t=fill,` +
      `drawbox=x=150:y=${productY + 110}:w=780:h=${productMaxH - 200}:color=${goldSoft}@0.045:t=fill[base2]`,
      
    `[base2][prod]overlay=x=(W-w)/2:y=${productY}+5*sin(2*PI*t/4):eval=frame[stage1]`,
    
    `[stage1]` +
      `drawbox=x=40:y=${cardY + 18}:w=1000:h=${cardH}:color=black@0.46:t=fill,` +
      `drawbox=x=58:y=${cardY}:w=964:h=${cardH}:color=${card}@0.90:t=fill,` +
      `drawbox=x=58:y=${cardY}:w=964:h=${cardH}:color=white@0.075:t=3,` +
      `drawbox=x=58:y=${cardY}:w=964:h=8:color=${yellow}@1:t=fill,` +
      `drawbox=x=90:y=${cardY + 34}:w=160:h=4:color=${yellow}@1:t=fill[stage2]`,
      
    `[stage2]` +
      `drawtext=text='PREÇO DE HOJE':fontcolor=${yellow}:fontsize=38:x=92:y=${cardY + 56}:shadowcolor=black@0.75:shadowx=2:shadowy=2,` +
      discountFilter +
      oldPriceFilter +
      `drawtext=text='${price}':fontcolor=${yellow}:fontsize=${priceFontSize}:x=(w-text_w)/2:y=${cardY + 202}:shadowcolor=black@0.90:shadowx=3:shadowy=3,` +
      `drawtext=text='APROVEITE ANTES QUE ACABE':fontcolor=${text}:fontsize=31:x=(w-text_w)/2:y=${cardY + 332}:shadowcolor=black@0.75:shadowx=2:shadowy=2,` +
      `drawtext=text='COMENTE':fontcolor=${text}:fontsize=45:x=(w-text_w)/2:y=${commentY}:shadowcolor=black@0.86:shadowx=2:shadowy=2,` +
      `drawbox=x=220:y=${idBoxY}:w=640:h=118:color=black@0.35:t=fill,` +
      `drawbox=x=230:y=${idBoxY - 8}:w=620:h=118:color=${yellow}@1:t=fill,` +
      `drawbox=x=230:y=${idBoxY - 8}:w=620:h=118:color=white@0.38:t=4:enable='lt(mod(t\\,1.35)\\,0.42)',` +
      `drawtext=text='ID ${idNumber}':fontcolor=black:fontsize=73:x=(w-text_w)/2:y=${idBoxY + 17},` +
      `drawtext=text='RECEBA O LINK NO DIRECT':fontcolor=${text}:fontsize=37:x=(w-text_w)/2:y=${subY}:shadowcolor=black@0.80:shadowx=2:shadowy=2,` +
      `drawtext=text='OFERTA VERIFICADA':fontcolor=${muted}:fontsize=27:x=66:y=${footerY},` +
      `drawtext=text='${brand}':fontcolor=${muted}:fontsize=27:x=w-text_w-66:y=${footerY}[stage3]`,

    hasBanner ? `[stage3][banner]overlay=0:${bannerY},format=yuv420p[out]` : `[stage3]format=yuv420p[out]`
  ].filter(Boolean);

  return filters.join(';');
}

async function buildReel(data, outPath) {
  const hasBanner = Boolean(data.brand_banner_url);
  const filter = buildProfessionalFilter(data, hasBanner);

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

// ==========================================
// ROTAS DA API (ENDPOINTS)
// ==========================================

// GET /health
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

// POST /create-reel
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
    const bannerUrl = body.brand_banner_url ? validateUrl(body.brand_banner_url, 'BRAND_BANNER_URL') : '';
    const produtoId = safeId(body.produto_id);
    const duration = Math.max(6, Math.min(Number(body.duration || 8), 10));

    const fileName = `professional_${produtoId}_${Date.now()}.mp4`;
    const outPath = path.join(OUTPUT_DIR, fileName);

    const data = {
      ...body,
      image_url: imageUrl,
      brand_banner_url: bannerUrl,
      produto_id: produtoId,
      duration,
      comentario: body.comentario || `ID ${produtoId}`,
      brand_name: body.brand_name || 'ACHEI DA HORA',
      brand_badge: body.brand_badge || 'OFERTA ESPECIAL',
      bg_color: body.bg_color || '0x050505',
      primary_color: body.primary_color || '0xFFE600',
      secondary_color: body.secondary_color || '0xD6B84A',
      accent_color: body.accent_color || '0xD92525',
      text_color: body.text_color || 'white',
      muted_color: body.muted_color || '0xBEBEBE',
      panel_color: body.panel_color || '0x101010'
    };

    console.log(`[create-reel] Iniciando geração: id=${produtoId} banner=${Boolean(data.brand_banner_url)} d=${duration}s`);

    await buildReel(data, outPath);

    res.json({
      ok: true,
      produto_id: produtoId,
      video_url: `${PUBLIC_BASE_URL}/reels/${fileName}`,
      filename: fileName,
      elapsed_ms: Date.now() - start
    });

  } catch (err) {
    console.error('[create-reel] Erro capturado:', err.message, err.stderr || '');

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

// DELETE /reels
app.delete('/reels', requireApiKey, async (req, res) => {
  try {
    const files = await fs.readdir(OUTPUT_DIR).catch(() => []);
    const mp4Files = files.filter(file => file.endsWith('.mp4'));

    // Exclusão concorrente paralela usando Promise.all (Performance Enterprise)
    await Promise.all(
      mp4Files.map(file => fs.remove(path.join(OUTPUT_DIR, file)))
    );

    res.json({
      ok: true,
      deleted: mp4Files.length
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'CLEANUP_FAILED' });
  }
});

// Inicialização do Servidor
app.listen(PORT, () => {
  console.log(`\x1b[32m[SERVER]\x1b[0m ${SERVICE_NAME} v${VERSION} escutando na porta ${PORT}`);
});
