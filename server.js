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

const SERVICE_NAME = 'reels-engine-modern';
const VERSION = '6.0.0';

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

  if (len >= 22) return 58;
  if (len >= 18) return 66;
  if (len >= 15) return 76;
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

function buildModernFilter(data, hasBanner) {
  const duration = Number(data.duration || 8);

  const bg = color(data.bg_color, '0x050505');
  const yellow = color(data.primary_color, '0xFFE600');
  const accent = color(data.accent_color, '0xFF1744');
  const cyan = color(data.secondary_color, '0x00D4FF');
  const text = color(data.text_color, 'white');
  const muted = color(data.muted_color, '0xB8B8B8');
  const card = color(data.panel_color, '0x0E0E0E');

  const brand = ffText(data.brand_name || 'ACHEI DA HORA', 32).toUpperCase();
  const badge = ffText(data.brand_badge || 'OFERTA RELÂMPAGO', 30).toUpperCase();

  const priceRaw = cleanText(data.preco || data.price || 'OFERTA ESPECIAL', 42).toUpperCase();
  const price = ffText(priceRaw, 42);

  const old = ffText(data.preco_original_text || data.preco_original || '', 38).toUpperCase();
  const discount = ffText(data.desconto || data.discount || '', 28).toUpperCase();

  const idNumber = ffText(extractId(data.comentario, data.produto_id), 14);
  const priceFontSize = fontSizeForPrice(priceRaw);

  const productMaxH = hasBanner ? 790 : 850;
  const productY = hasBanner ? 210 : 230;

  const cardY = hasBanner ? 1040 : 1100;
  const cardH = hasBanner ? 620 : 640;

  const ctaY = hasBanner ? 1488 : 1558;
  const subY = hasBanner ? 1645 : 1712;
  const footerY = hasBanner ? 1704 : 1848;

  const bannerY = 1755;

  const filters = [
    // Divide a imagem em duas: uma para o fundo e outra para o produto principal.
    `[0:v]split=2[bgsrc][prodsrc]`,

    // Fundo moderno: a própria imagem vira background desfocado, escuro e mais saturado.
    `[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=24:luma_power=2,eq=brightness=-0.34:saturation=1.25[bgblur]`,

    // Produto principal, preservando proporção.
    `[prodsrc]scale=930:${productMaxH}:force_original_aspect_ratio=decrease,format=rgba[prod]`,

    // Faixa diagonal neon amarela.
    `color=c=${yellow}@0.18:s=1350x95:d=${duration},format=rgba,rotate=-0.18:c=none:ow=rotw(-0.18):oh=roth(-0.18)[slash1]`,

    // Faixa diagonal ciano para dar cara mais tecnológica/moderna.
    `color=c=${cyan}@0.12:s=1250x60:d=${duration},format=rgba,rotate=-0.18:c=none:ow=rotw(-0.18):oh=roth(-0.18)[slash2]`,

    // Se tiver banner, prepara o banner.
    hasBanner
      ? `[1:v]scale=1080:-1:force_original_aspect_ratio=increase,crop=1080:min(150\\,ih):0:0[banner]`
      : null,

    // Aplica overlays diagonais no fundo.
    `[bgblur][slash1]overlay=x=-150:y=170:shortest=1[bg1]`,
    `[bg1][slash2]overlay=x=-90:y=318:shortest=1[bg2]`,

    // Camada escura para contraste.
    `[bg2]drawbox=x=0:y=0:w=1080:h=1920:color=${bg}@0.36:t=fill[base0]`,

    // Topo moderno.
    `[base0]` +
      `drawbox=x=0:y=0:w=1080:h=154:color=black@0.58:t=fill,` +
      `drawbox=x=42:y=42:w=454:h=78:color=${yellow}@1:t=fill,` +
      `drawtext=text='${badge}':fontcolor=black:fontsize=35:x=70:y=62:shadowcolor=black@0.18:shadowx=1:shadowy=1,` +
      `drawtext=text='${brand}':fontcolor=${text}:fontsize=30:x=540:y=65:shadowcolor=black@0.8:shadowx=2:shadowy=2,` +
      `drawbox=x=42:y=138:w=222:h=48:color=${accent}@0.95:t=fill,` +
      `drawtext=text='ACHADO TOP':fontcolor=white:fontsize=26:x=68:y=151:shadowcolor=black@0.55:shadowx=2:shadowy=2,` +
      `drawbox=x=292:y=160:w=744:h=3:color=${yellow}@0.78:t=fill[base1]`,

    // Glow atrás do produto.
    `[base1]` +
      `drawbox=x=72:y=${productY - 18}:w=936:h=${productMaxH + 52}:color=black@0.22:t=fill,` +
      `drawbox=x=118:y=${productY + 18}:w=844:h=${productMaxH - 16}:color=${yellow}@0.055:t=fill,` +
      `drawbox=x=172:y=${productY + 68}:w=736:h=${productMaxH - 118}:color=${cyan}@0.045:t=fill[base2]`,

    // Produto com movimento sutil flutuando.
    `[base2][prod]overlay=x=(W-w)/2:y=${productY}+10*sin(2*PI*t/3):eval=frame[stage1]`,

    // Card glass moderno.
    `[stage1]` +
      `drawbox=x=40:y=${cardY + 18}:w=1000:h=${cardH}:color=black@0.42:t=fill,` +
      `drawbox=x=58:y=${cardY}:w=964:h=${cardH}:color=${card}@0.82:t=fill,` +
      `drawbox=x=58:y=${cardY}:w=964:h=${cardH}:color=white@0.08:t=4,` +
      `drawbox=x=58:y=${cardY}:w=964:h=8:color=${yellow}@1:t=fill,` +
      `drawbox=x=58:y=${cardY + cardH - 8}:w=964:h=8:color=${cyan}@0.60:t=fill[stage2]`,

    // Conteúdo do card.
    `[stage2]` +
      `drawtext=text='PREÇO DE HOJE':fontcolor=${yellow}:fontsize=38:x=92:y=${cardY + 52}:shadowcolor=black@0.8:shadowx=2:shadowy=2,` +

      (
        discount
          ? `drawbox=x=690:y=${cardY + 34}:w=296:h=78:color=${accent}@1:t=fill,` +
            `drawtext=text='${discount}':fontcolor=white:fontsize=39:x=690+(296-text_w)/2:y=${cardY + 55}:shadowcolor=black@0.45:shadowx=2:shadowy=2,`
          : ''
      ) +

      (
        old
          ? `drawtext=text='${old}':fontcolor=${muted}:fontsize=34:x=(w-text_w)/2:y=${cardY + 132}:shadowcolor=black@0.65:shadowx=2:shadowy=2,`
          : ''
      ) +

      `drawtext=text='${price}':fontcolor=${yellow}:fontsize=${priceFontSize}:x=(w-text_w)/2:y=${cardY + 196}:shadowcolor=black@0.9:shadowx=3:shadowy=3,` +
      `drawtext=text='PROMOÇÃO COM ESTOQUE LIMITADO':fontcolor=${text}:fontsize=31:x=(w-text_w)/2:y=${cardY + 326}:shadowcolor=black@0.75:shadowx=2:shadowy=2,` +

      // CTA principal.
      `drawbox=x=112:y=${ctaY}:w=856:h=132:color=${yellow}@1:t=fill,` +
      `drawbox=x=112:y=${ctaY}:w=856:h=132:color=white@0.45:t=4:enable='lt(mod(t\\,1.2)\\,0.55)',` +
      `drawtext=text='COMENTE ID ${idNumber}':fontcolor=black:fontsize=63:x=(w-text_w)/2:y=${ctaY + 34},` +

      // Sub CTA.
      `drawtext=text='RECEBA O LINK NO DIRECT':fontcolor=${text}:fontsize=38:x=(w-text_w)/2:y=${subY}:shadowcolor=black@0.78:shadowx=2:shadowy=2,` +

      // Rodapé.
      `drawtext=text='OFERTA VERIFICADA':fontcolor=${muted}:fontsize=27:x=66:y=${footerY},` +
      `drawtext=text='${brand}':fontcolor=${muted}:fontsize=27:x=w-text_w-66:y=${footerY}[stage3]`,

    // Banner opcional ou saída final.
    hasBanner
      ? `[stage3][banner]overlay=0:${bannerY},format=yuv420p[out]`
      : `[stage3]format=yuv420p[out]`
  ].filter(Boolean);

  return filters.join(';');
}

async function buildReel(data, outPath) {
  const hasBanner = Boolean(data.brand_banner_url);
  const filter = buildModernFilter(data, hasBanner);

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

    const fileName = `modern_${produtoId}_${Date.now()}.mp4`;
    const outPath = path.join(OUTPUT_DIR, fileName);

    const data = {
      ...body,
      image_url: imageUrl,
      brand_banner_url: bannerUrl,
      produto_id: produtoId,
      duration,
      comentario: body.comentario || `ID ${produtoId}`,

      // Defaults visuais modernos.
      brand_name: body.brand_name || 'ACHEI DA HORA',
      brand_badge: body.brand_badge || 'OFERTA RELÂMPAGO',

      bg_color: body.bg_color || '0x050505',
      primary_color: body.primary_color || '0xFFE600',
      accent_color: body.accent_color || '0xFF1744',
      secondary_color: body.secondary_color || '0x00D4FF',
      text_color: body.text_color || 'white',
      muted_color: body.muted_color || '0xB8B8B8',
      panel_color: body.panel_color || '0x0E0E0E'
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
