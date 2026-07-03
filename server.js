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
const VERSION = '10.1.7';

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

function fontSizeForNewTemplatePrice(price) {
  const len = String(price || '').length;

  if (len >= 12) return 70;
  if (len >= 10) return 78;
  if (len >= 9) return 86;
  if (len >= 8) return 94;

  return 102;
}

function buildAcheiStoryFilter(data) {
  // Área da imagem:
  // sem drawbox branco artificial; apenas encaixa a imagem grande na área
  const productAreaX = 95;
  const productAreaY = 220;
  const productAreaW = 890;
  const productAreaH = 820;

  // Cards
  const discountBox = { x: 58, y: 1088, w: 215, h: 155 };
  const oldBox = { x: 58, y: 1265, w: 310, h: 155 };
  const priceBox = { x: 385, y: 1265, w: 640, h: 155 };
  const ctaBox = { x: 210, y: 1445, w: 700, h: 110 };
  const ctaSubBox = { x: 255, y: 1565, w: 610, h: 72 };

  const titleArea = { x: 330, y: 1085, w: 590 };
  const titleLines = splitTextLines(data.titulo || data.title || '', 20, 2)
    .map(line => ffText(line, 42));

  const longestTitle = Math.max(...titleLines.map(line => line.length), 0);
  const titleFontSize =
    longestTitle > 18 ? 38 :
    longestTitle > 15 ? 43 :
    48;

  const titleGap = titleFontSize + 8;

  const priceRaw = cleanText(data.preco || data.price || '', 42);
  const priceNumberRaw = normalizeCurrentPriceNumber(priceRaw);
  const priceNumber = ffText(priceNumberRaw, 20);
  const priceFontSize = fontSizeForNewTemplatePrice(priceNumberRaw);

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

  // Título
  if (titleLines[0]) {
    draws.push(
      `drawtext=text='${titleLines[0]}':fontcolor=black:fontsize=${titleFontSize}:x=${titleArea.x}+(${titleArea.w}-text_w)/2:y=${titleArea.y}:expansion=none`
    );
  }

  if (titleLines[1]) {
    draws.push(
      `drawtext=text='${titleLines[1]}':fontcolor=black:fontsize=${titleFontSize}:x=${titleArea.x}+(${titleArea.w}-text_w)/2:y=${titleArea.y + titleGap}:expansion=none`
    );
  }

  // Desconto centralizado no card amarelo
  if (discountNum) {
    draws.push(
      `drawtext=text='${discountNum}':fontcolor=black:fontsize=74:x=${discountBox.x}+(${discountBox.w}-text_w)/2-8:y=${discountBox.y}+14:expansion=none`,
      `drawtext=text='% OFF':fontcolor=black:fontsize=28:x=${discountBox.x}+(${discountBox.w}-text_w)/2+20:y=${discountBox.y}+92:expansion=none`
    );
  }

  // Preço antigo centralizado no box preto esquerdo
  if (oldPriceValue) {
    draws.push(
      `drawtext=text='DE':fontcolor=white:fontsize=46:x=${oldBox.x}+(${oldBox.w}-text_w)/2:y=${oldBox.y}+16:expansion=none`,
      `drawtext=text='R$ ${oldPriceValue}':fontcolor=white:fontsize=33:x=${oldBox.x}+(${oldBox.w}-text_w)/2:y=${oldBox.y}+82:expansion=none`
    );
  }

  // Preço novo: POR e R$ na coluna esquerda; valor centralizado na área direita
  if (priceNumber) {
    draws.push(
      `drawtext=text='POR':fontcolor=white:fontsize=36:x=${priceBox.x}+18:y=${priceBox.y}+18:expansion=none`,
      `drawtext=text='R$':fontcolor=white:fontsize=58:x=${priceBox.x}+18:y=${priceBox.y}+72:expansion=none`,
      `drawtext=text='${priceNumber}':fontcolor=white:fontsize=${priceFontSize}:x=${priceBox.x}+175+((${priceBox.w}-195)-text_w)/2:y=${priceBox.y}+18:expansion=none`
    );
  }

  // CTA amarelo + número
  draws.push(
    `drawtext=text='COMENTA O Nº':fontcolor=black:fontsize=42:x=${ctaBox.x}+20+((460)-text_w)/2:y=${ctaBox.y}+24:expansion=none`,
    `drawtext=text='${idNumber}':fontcolor=0xE53935:fontsize=76:x=${ctaBox.x}+520+((130)-text_w)/2:y=${ctaBox.y}+10:expansion=none`,
    `drawtext=text='QUE TE MANDO O LINK':fontcolor=white:fontsize=34:x=${ctaSubBox.x}+(${ctaSubBox.w}-text_w)/2:y=${ctaSubBox.y}+16:expansion=none`
  );

  return [
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=rgba[base]`,
    `[1:v]scale=${productAreaW}:${productAreaH}:force_original_aspect_ratio=decrease,format=rgba[prod]`,
    `[base][prod]overlay=x=${productAreaX}+(${productAreaW}-w)/2:y=${productAreaY}+(${productAreaH}-h)/2:shortest=1[stage1]`,
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
  return buildAcheiStoryReel(data, outPath);
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

    const layout = cleanText(body.layout || 'achei_story', 30);

    const templateUrl = body.template_url
      ? validateUrl(body.template_url, 'TEMPLATE_URL')
      : `${PUBLIC_BASE_URL}/assets/achei-story-base.png`;

    const produtoId = safeId(body.produto_id);
    const duration = Math.max(6, Math.min(Number(body.duration || 8), 10));
    const safeLayout = safeId(layout);

    const fileName = `${safeLayout}_${produtoId}_${Date.now()}.mp4`;
    const outPath = path.join(OUTPUT_DIR, fileName);

    const data = {
      ...body,
      layout,
      image_url: imageUrl,
      template_url: templateUrl,
      produto_id: produtoId,
      duration,
      comentario: body.comentario || `ID ${produtoId}`,
    };

    console.log(
      `[create-reel] start layout=${layout} id=${produtoId} image_url=${imageUrl} duration=${duration}`
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
