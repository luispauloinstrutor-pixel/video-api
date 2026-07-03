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
const ASSETS_DIR = path.join(__dirname, 'public', 'assets');

const SERVICE_NAME = 'reels-engine-pro';
const VERSION = '10.1.5';

const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 120000);
const MAX_FFMPEG_JOBS = Number(process.env.MAX_FFMPEG_JOBS || 1);

let activeFFmpegJobs = 0;

fs.ensureDirSync(OUTPUT_DIR);
fs.ensureDirSync(ASSETS_DIR);

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '3mb' }));

app.use('/reels', express.static(OUTPUT_DIR, {
  maxAge: '7d',
  immutable: true,
}));

app.use('/assets', express.static(ASSETS_DIR, {
  maxAge: '7d',
  immutable: true,
}));

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();

  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHORIZED',
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
    .replace(/^=+/, '')
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

const NAMED_COLOR_MAP = {
  yellow: '0xF2C94C',
  gold: '0xD8B45A',
  red: '0xD71920',
  black: '0x070707',
  dark: '0x070707',
  white: 'white',
  gray: '0xB8B8B8',
  grey: '0xB8B8B8',
};

function color(value, fallback) {
  const raw = String(value || fallback).trim();
  const named = NAMED_COLOR_MAP[raw.toLowerCase()];

  if (named) return named;

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

  if (len >= 24) return 54;
  if (len >= 21) return 60;
  if (len >= 18) return 68;
  if (len >= 15) return 78;
  if (len >= 12) return 88;

  return 102;
}

function fontSizeForNewTemplatePrice(price) {
  const len = String(price || '').length;

  if (len >= 12) return 76;
  if (len >= 10) return 86;
  if (len >= 8) return 98;

  return 108;
}

function normalizeDiscount(value) {
  const raw = cleanText(value || '', 24).toUpperCase();

  if (!raw) return '';

  if (/^\d{1,3}$/.test(raw)) return `${raw}% OFF`;
  if (/^(\d{1,3})\s*%$/.test(raw)) return raw.replace(/^(\d{1,3})\s*%$/, '$1% OFF');
  if (/^(\d{1,3})\s*OFF$/.test(raw)) return raw.replace(/^(\d{1,3})\s*OFF$/, '$1% OFF');
  if (/^(\d{1,3})\s*%\s*OFF$/.test(raw)) return raw;

  return raw;
}

function discountNumber(value) {
  const raw = normalizeDiscount(value);
  const m = raw.match(/(\d{1,3})/);
  return m ? m[1] : '';
}

function parseMoneyBR(value) {
  let raw = String(value || '').replace(/[^\d,.]/g, '').trim();
  if (!raw) return null;

  if (raw.includes(',')) {
    raw = raw.replace(/\./g, '').replace(',', '.');
  }

  const number = Number(raw);
  if (!Number.isFinite(number)) return null;

  return number;
}

function calculateDiscountText(oldPriceText, newPriceText) {
  const oldPrice = parseMoneyBR(oldPriceText);
  const newPrice = parseMoneyBR(newPriceText);

  if (!oldPrice || !newPrice) return '';
  if (oldPrice <= 0 || newPrice <= 0) return '';
  if (newPrice >= oldPrice) return '';

  const percentage = Math.round((1 - newPrice / oldPrice) * 100);
  if (!Number.isFinite(percentage)) return '';
  if (percentage <= 0 || percentage > 99) return '';

  return `${percentage}% OFF`;
}

function normalizeOldPriceText(value) {
  const raw = cleanText(value || '', 40).toUpperCase();
  if (!raw) return '';
  if (raw.startsWith('DE ')) return raw;
  if (raw.startsWith('R$')) return `DE ${raw}`;
  return raw;
}

function normalizeOldPriceValue(value) {
  let raw = normalizeOldPriceText(value).replace(/^DE\s*/i, '').trim();
  raw = raw.replace(/^R\$\s*/i, '').trim();
  return raw;
}

function normalizeCurrentPriceNumber(value) {
  let raw = cleanText(value || '', 42).toUpperCase();

  raw = raw
    .replace(/^POR\s*/i, '')
    .replace(/^R\$\s*/i, '')
    .trim();

  const m = raw.match(/(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}|\d+)/);
  return m ? m[1] : raw;
}

function splitTextLines(value, maxChars = 34, maxLines = 2) {
  const text = cleanText(value, maxChars * maxLines + 20);
  const words = text.split(' ').filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;

    if (next.length <= maxChars) {
      current = next;
      continue;
    }

    if (current) lines.push(current);
    current = word;

    if (lines.length === maxLines - 1) break;
  }

  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

function normalizeUrl(value) {
  let raw = String(value || '');

  raw = raw
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^["']+|["']+$/g, '')
    .trim();

  raw = raw.replace(/\s+/g, '');
  return raw;
}

function validateUrl(value, fieldName) {
  const raw = normalizeUrl(value);

  if (!raw) {
    const err = new Error(`${fieldName}_REQUIRED`);
    err.statusCode = 400;
    err.publicCode = `${fieldName}_REQUIRED`;
    throw err;
  }

  if (raw.length > 3000) {
    const err = new Error(`${fieldName}_TOO_LONG`);
    err.statusCode = 400;
    err.publicCode = `${fieldName}_TOO_LONG`;
    throw err;
  }

  const lower = raw.toLowerCase();

  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    const err = new Error(`${fieldName}_INVALID_URL`);
    err.statusCode = 400;
    err.publicCode = `${fieldName}_INVALID_URL`;
    throw err;
  }

  try {
    const parsed = new URL(raw);
    return parsed.toString();
  } catch {
    return encodeURI(raw);
  }
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-nostdin', ...args],
      {
        timeout: FFMPEG_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
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
    outPath,
  ];
}

function buildElegantFilter(data, hasBanner) {
  const duration = Number(data.duration || 8);

  const bg = color(data.bg_color, '0x070707');
  const primary = color(data.primary_color, '0xF2C94C');
  const accent = color(data.accent_color, '0xB83232');
  const text = color(data.text_color, 'white');
  const muted = color(data.muted_color, '0xB8B8B8');
  const panel = color(data.panel_color, '0x111111');
  const softPanel = color(data.soft_panel_color, '0x181818');

  const brand = ffText(data.brand_name || 'ACHEI DA HORA', 34).toUpperCase();
  const badge = ffText(data.brand_badge || 'OFERTA DO DIA', 28).toUpperCase();

  const titleLines = splitTextLines(data.titulo || data.title || 'Achadinho selecionado', 35, 2)
    .map(line => ffText(line, 42).toUpperCase());

  const priceRaw = cleanText(data.preco || data.price || 'OFERTA ESPECIAL', 42).toUpperCase();
  const price = ffText(priceRaw, 42);

  const oldRaw = cleanText(data.preco_original_text || data.preco_original || '', 38).toUpperCase();
  const old = ffText(oldRaw, 38).toUpperCase();

  const discountRaw =
    normalizeDiscount(
      data.desconto ||
      data.discount ||
      data.desconto_text ||
      data.discount_text ||
      ''
    ) || calculateDiscountText(oldRaw, priceRaw);

  const discount = ffText(discountRaw, 24).toUpperCase();

  const idNumber = ffText(extractId(data.comentario, data.produto_id), 14);
  const priceFontSize = fontSizeForPrice(priceRaw);

  const productH = hasBanner ? 770 : 830;
  const productY = hasBanner ? 185 : 195;

  const cardY = hasBanner ? 1005 : 1055;
  const cardH = hasBanner ? 700 : 720;
  const bannerY = 1755;
  const bannerH = 165;

  const cardDraws = [
    `drawbox=x=56:y=${cardY}:w=968:h=${cardH}:color=${panel}@0.96:t=fill`,
    `drawbox=x=56:y=${cardY}:w=968:h=${cardH}:color=white@0.08:t=2`,
    `drawbox=x=96:y=${cardY + 42}:w=112:h=4:color=${primary}@1:t=fill`,
  ];

  if (titleLines[0]) {
    cardDraws.push(
      `drawtext=text='${titleLines[0]}':fontcolor=${text}:fontsize=34:x=96:y=${cardY + 70}:shadowcolor=black@0.70:shadowx=2:shadowy=2:expansion=none`
    );
  }

  if (titleLines[1]) {
    cardDraws.push(
      `drawtext=text='${titleLines[1]}':fontcolor=${muted}:fontsize=30:x=96:y=${cardY + 116}:shadowcolor=black@0.60:shadowx=2:shadowy=2:expansion=none`
    );
  }

  cardDraws.push(
    `drawtext=text='PREÇO DE HOJE':fontcolor=${primary}:fontsize=36:x=96:y=${cardY + 188}:shadowcolor=black@0.65:shadowx=2:shadowy=2:expansion=none`
  );

  if (discount) {
    cardDraws.push(
      `drawbox=x=730:y=${cardY + 166}:w=238:h=68:color=${accent}@0.96:t=fill`,
      `drawbox=x=730:y=${cardY + 166}:w=238:h=68:color=white@0.13:t=2`,
      `drawtext=text='${discount}':fontcolor=white:fontsize=31:x=730+(238-text_w)/2:y=${cardY + 184}:shadowcolor=black@0.60:shadowx=2:shadowy=2:expansion=none`
    );
  } else {
    cardDraws.push(
      `drawbox=x=730:y=${cardY + 166}:w=238:h=68:color=${accent}@0.96:t=fill`,
      `drawbox=x=730:y=${cardY + 166}:w=238:h=68:color=white@0.13:t=2`,
      `drawtext=text='OFERTA':fontcolor=white:fontsize=31:x=730+(238-text_w)/2:y=${cardY + 184}:shadowcolor=black@0.60:shadowx=2:shadowy=2:expansion=none`
    );
  }

  if (old) {
    cardDraws.push(
      `drawtext=text='${old}':fontcolor=${muted}:fontsize=31:x=(w-text_w)/2:y=${cardY + 270}:shadowcolor=black@0.65:shadowx=2:shadowy=2:expansion=none`
    );
  }

  cardDraws.push(
    `drawtext=text='${price}':fontcolor=${primary}:fontsize=${priceFontSize}:x=(w-text_w)/2:y=${cardY + 330}:shadowcolor=black@0.85:shadowx=3:shadowy=3:expansion=none`,
    `drawtext=text='COMENTA':fontcolor=${text}:fontsize=42:x=(w-text_w)/2:y=${cardY + 462}:shadowcolor=black@0.80:shadowx=2:shadowy=2:expansion=none`,
    `drawbox=x=230:y=${cardY + 522}:w=620:h=112:color=${primary}@1:t=fill`,
    `drawtext=text='${idNumber}':fontcolor=black:fontsize=70:x=(w-text_w)/2:y=${cardY + 548}:expansion=none`,
    `drawtext=text='QUE TE MANDO O LINK NO DIRECT':fontcolor=${text}:fontsize=34:x=(w-text_w)/2:y=${cardY + 655}:shadowcolor=black@0.78:shadowx=2:shadowy=2:expansion=none`
  );

  const filters = [
    `color=c=${bg}:s=1080x1920:d=${duration},format=rgba[canvas]`,
    `[0:v]scale=900:${productH}:force_original_aspect_ratio=decrease,format=rgba[prod]`,
    hasBanner
      ? `[1:v]scale=1080:${bannerH}:force_original_aspect_ratio=increase,crop=1080:${bannerH},format=rgba[banner]`
      : null,
    `[canvas]` +
      `drawbox=x=0:y=0:w=1080:h=150:color=black@0.34:t=fill,` +
      `drawtext=text='${brand}':fontcolor=${text}:fontsize=34:x=64:y=54:shadowcolor=black@0.70:shadowx=2:shadowy=2:expansion=none,` +
      `drawbox=x=730:y=42:w=286:h=66:color=${primary}@1:t=fill,` +
      `drawtext=text='${badge}':fontcolor=black:fontsize=30:x=730+(286-text_w)/2:y=61:expansion=none,` +
      `drawbox=x=64:y=144:w=952:h=2:color=${primary}@0.55:t=fill,` +
      `drawbox=x=64:y=${productY}:w=952:h=${productH + 40}:color=${softPanel}@0.88:t=fill,` +
      `drawbox=x=64:y=${productY}:w=952:h=${productH + 40}:color=white@0.06:t=2,` +
      `drawbox=x=94:y=${productY + 30}:w=892:h=${productH - 20}:color=black@0.18:t=fill[base1]`,
    `[base1][prod]overlay=x=(W-w)/2:y=${productY}+20+(${productH}-h)/2:shortest=1[stage1]`,
    `[stage1]${cardDraws.join(',')}[stage2]`,
    `[stage2]` +
      `drawtext=text='OFERTA VERIFICADA':fontcolor=${muted}:fontsize=26:x=64:y=${hasBanner ? 1714 : 1840}:expansion=none,` +
      `drawtext=text='${brand}':fontcolor=${muted}:fontsize=26:x=w-text_w-64:y=${hasBanner ? 1714 : 1840}:expansion=none[stage3]`,
    hasBanner
      ? `[stage3][banner]overlay=0:${bannerY}:shortest=1,format=yuv420p[out]`
      : `[stage3]format=yuv420p[out]`,
  ].filter(Boolean);

  return filters.join(';');
}

function buildAcheiStoryFilter(data) {
  const productBoxX = 130;
  const productBoxY = 235;
  const productBoxW = 820;
  const productBoxH = 900;

  const productMaxW = 820;
  const productMaxH = 880;

  const rawTitle = cleanText(data.titulo || data.title || '', 80);
  const titleLines = splitTextLines(rawTitle, 22, 2)
    .map(line => ffText(line, 42));

  const longestTitle = Math.max(...titleLines.map(line => line.length), 0);
  const titleFontSize =
    longestTitle > 20 ? 40 :
    longestTitle > 16 ? 45 :
    50;

  const titleX = 382;
  const titleY = 1170;
  const titleGap = titleFontSize + 10;

  const priceRaw = cleanText(data.preco || data.price || '', 42);
  const priceNumberRaw = normalizeCurrentPriceNumber(priceRaw);
  const priceNumber = ffText(priceNumberRaw, 20);

  let priceFontSize = fontSizeForNewTemplatePrice(priceNumberRaw);
  if (priceNumberRaw.length >= 10) priceFontSize = 82;
  else if (priceNumberRaw.length >= 9) priceFontSize = 88;
  else if (priceNumberRaw.length >= 8) priceFontSize = 96;
  else priceFontSize = 104;

  const oldRaw = normalizeOldPriceText(data.preco_original_text || data.preco_original || '');
  const oldPriceValue = ffText(normalizeOldPriceValue(oldRaw), 24).toUpperCase();

  const discountRaw =
    normalizeDiscount(
      data.desconto ||
      data.discount ||
      data.desconto_text ||
      data.discount_text ||
      ''
    ) || calculateDiscountText(oldRaw, priceRaw);

  const discountNum = ffText(discountNumber(discountRaw), 4);
  const idNumber = ffText(extractId(data.comentario, data.produto_id), 14);

  const draws = [];

  if (discountNum) {
    draws.push(
      `drawtext=text='${discountNum}':fontcolor=black:fontsize=92:x=105:y=1182:expansion=none`,
      `drawtext=text='%':fontcolor=black:fontsize=40:x=227:y=1194:expansion=none`,
      `drawtext=text='OFF':fontcolor=black:fontsize=26:x=227:y=1240:expansion=none`
    );
  }

  if (titleLines[0]) {
    draws.push(
      `drawtext=text='${titleLines[0]}':fontcolor=black:fontsize=${titleFontSize}:x=${titleX}:y=${titleY}:expansion=none`
    );
  }

  if (titleLines[1]) {
    draws.push(
      `drawtext=text='${titleLines[1]}':fontcolor=black:fontsize=${titleFontSize}:x=${titleX}:y=${titleY + titleGap}:expansion=none`
    );
  }

  if (oldPriceValue) {
    draws.push(
      `drawtext=text='DE':fontcolor=white:fontsize=50:x=96:y=1340:expansion=none`,
      `drawtext=text='R$ ${oldPriceValue}':fontcolor=white:fontsize=35:x=96:y=1402:expansion=none`
    );
  }

  if (priceNumber) {
    draws.push(
      `drawtext=text='POR':fontcolor=white:fontsize=45:x=397:y=1336:expansion=none`,
      `drawtext=text='R$':fontcolor=white:fontsize=62:x=397:y=1395:expansion=none`,
      `drawtext=text='${priceNumber}':fontcolor=white:fontsize=${priceFontSize}:x=545:y=1348:expansion=none`
    );
  }

  draws.push(
    `drawtext=text='COMENTA O Nº':fontcolor=black:fontsize=44:x=255:y=1533:expansion=none`,
    `drawtext=text='${idNumber}':fontcolor=0xFF0000:fontsize=84:x=660+(150-text_w)/2:y=1522:expansion=none`,
    `drawtext=text='QUE TE MANDO O LINK':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=1625:expansion=none`
  );

  return [
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=rgba[base]`,
    `[1:v]scale=${productMaxW}:${productMaxH}:force_original_aspect_ratio=decrease,format=rgba[prod]`,
    `[base]drawbox=x=${productBoxX}:y=${productBoxY}:w=${productBoxW}:h=${productBoxH}:color=white@1:t=fill[baseBox]`,
    `[baseBox][prod]overlay=x=${productBoxX}+(${productBoxW}-w)/2:y=${productBoxY}+(${productBoxH}-h)/2:shortest=1[stage1]`,
    `[stage1]${draws.join(',')},format=yuv420p[out]`,
  ].join(';');
}

async function buildAcheiStoryReel(data, outPath) {
  const filter = buildAcheiStoryFilter(data);

  const localTemplatePath = path.join(ASSETS_DIR, 'achei-story-base.png');
  const templateInput = fs.existsSync(localTemplatePath)
    ? localTemplatePath
    : data.template_url;

  const args = [
    '-y',
    '-loop', '1',
    '-t', String(data.duration),
    '-i', templateInput,
    '-loop', '1',
    '-t', String(data.duration),
    '-i', data.image_url,
    '-filter_complex', filter,
    '-map', '[out]',
    ...outputArgs(outPath),
  ];

  await ffmpeg(args);
}

async function buildReel(data, outPath) {
  if (data.layout === 'achei_story') {
    return buildAcheiStoryReel(data, outPath);
  }

  const hasBanner = Boolean(data.brand_banner_url);
  const filter = buildElegantFilter(data, hasBanner);

  const args = [
    '-y',
    '-loop', '1',
    '-t', String(data.duration),
    '-i', data.image_url,
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
    assets_dir: ASSETS_DIR,
    template_url: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/assets/achei-story-base.png` : '',
    active_jobs: activeFFmpegJobs,
    max_jobs: MAX_FFMPEG_JOBS,
  });
});

app.post('/create-reel', requireApiKey, async (req, res) => {
  const start = Date.now();

  if (!acquireJobSlot()) {
    return res.status(429).json({
      ok: false,
      error: 'SERVER_BUSY',
      message: 'Já existe uma geração de vídeo em andamento. Tente novamente em alguns segundos.',
    });
  }

  try {
    const body = req.body || {};

    if (!PUBLIC_BASE_URL) {
      return res.status(500).json({
        ok: false,
        error: 'MISSING_PUBLIC_BASE_URL',
      });
    }

    const layout = cleanText(body.layout || 'elegant', 30);
    const imageUrl = normalizeUrl(body.image_url);

    if (!imageUrl) {
      return res.status(400).json({
        ok: false,
        error: 'IMAGE_URL_REQUIRED',
        message: 'A URL da imagem do produto veio vazia.',
        received_image_url: body.image_url || '',
        normalized_image_url: imageUrl || '',
        elapsed_ms: Date.now() - start,
      });
    }

    const bannerUrl = body.brand_banner_url
      ? validateUrl(body.brand_banner_url, 'BRAND_BANNER_URL')
      : '';

    const templateUrl = layout === 'achei_story'
      ? (
          body.template_url
            ? validateUrl(body.template_url, 'TEMPLATE_URL')
            : `${PUBLIC_BASE_URL}/assets/achei-story-base.png`
        )
      : (
          body.template_url
            ? validateUrl(body.template_url, 'TEMPLATE_URL')
            : ''
        );

    const produtoId = safeId(body.produto_id);
    const duration = Math.max(6, Math.min(Number(body.duration || 8), 10));
    const safeLayout = safeId(layout);

    const fileName = `${safeLayout}_${produtoId}_${Date.now()}.mp4`;
    const outPath = path.join(OUTPUT_DIR, fileName);

    const data = {
      ...body,
      layout,
      image_url: imageUrl,
      brand_banner_url: bannerUrl,
      template_url: templateUrl,
      produto_id: produtoId,
      duration,
      comentario: body.comentario || `ID ${produtoId}`,
      brand_name: body.brand_name || 'ACHEI DA HORA',
      brand_badge: body.brand_badge || 'OFERTA DO DIA',
      bg_color: body.bg_color || '0x070707',
      primary_color: body.primary_color || '0xF2C94C',
      accent_color: body.accent_color || '0xB83232',
      text_color: body.text_color || 'white',
      muted_color: body.muted_color || '0xB8B8B8',
      panel_color: body.panel_color || '0x111111',
      soft_panel_color: body.soft_panel_color || '0x181818',
    };

    console.log(
      `[create-reel] start layout=${layout} id=${produtoId} image_url=${imageUrl} template=${Boolean(data.template_url)} duration=${duration}`
    );

    await buildReel(data, outPath);

    const videoUrl = `${PUBLIC_BASE_URL}/reels/${fileName}`;

    res.json({
      ok: true,
      produto_id: produtoId,
      layout,
      video_url: videoUrl,
      filename: fileName,
      elapsed_ms: Date.now() - start,
    });
  } catch (err) {
    const stderrText = String(err.stderr || '').slice(-4000);

    console.error('[create-reel] error', err.message, stderrText);

    res.status(err.statusCode || 500).json({
      ok: false,
      error: err.publicCode || 'VIDEO_CREATION_FAILED',
      message: err.statusCode ? err.message : 'Falha ao criar vídeo.',
      ffmpeg_error: stderrText,
      elapsed_ms: Date.now() - start,
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

  res.json({ ok: true, deleted });
});

app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} v${VERSION} running on port ${PORT}`);
});
