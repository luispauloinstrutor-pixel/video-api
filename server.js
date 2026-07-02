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

// Inicialização do diretório de saída
fs.ensureDirSync(OUTPUT_DIR);

// ==========================================
// MIDDLEWARES E ESTÁTICOS
// ==========================================
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '3mb' }));

app.use('/reels', express.static(OUTPUT_DIR, {
  maxAge: '7d',
  immutable: true
}));

// Middleware de Autenticação
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
// GERENCIADOR DE CONCORRÊNCIA (JOBS)
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
// TRATAMENTO DE TEXTOS E PARAMETROS
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
// PROCESSO DO FFmpeg (CONVERSÃO DE VÍDEO)
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

  // Paleta de Cores Otimizada para Alta Conversão
  const bg = color(data.bg_color, '0x0A0A0C');          
  const yellow = color(data.primary_color, '0xFFE600');  
  const goldSoft = color(data.secondary_color, '0x1F1F24'); 
  const accent = color(data.accent_color, '0xFA2A46');    
  const text = color(data.text_color, 'white');
  const muted = color(data.muted_color, '0xA0A0AB');     
  const card = color(data.panel_color, '0x121216');      

  // Tratamento Textual de Alto Impacto
  const brand = ffText(data.brand_name || 'ACHEI DA HORA', 34).toUpperCase();
  const badge = ffText(data.brand_badge || 'OFERTA IMPERDÍVEL', 30).toUpperCase();
  const priceRaw = cleanText(data.preco || data.price || 'OFERTA ESPECIAL', 42).toUpperCase();
  const price = ffText(priceRaw, 42);
  const old = ffText(data.preco_original_text || data.preco_original || '', 38).toUpperCase();
  const discount = ffText(data.desconto || data.discount || '', 24).toUpperCase();
  const idNumber = ffText(extractId(data.comentario, data.produto_id), 14);
  const priceFontSize = fontSizeForPrice(priceRaw);

  // Dimensionamento Vertical Seguro (Evita cortes nas interfaces das redes sociais)
  const productMaxH = hasBanner ? 780 : 840;
  const productY = hasBanner ? 210 : 230;
  const cardY = hasBanner ? 1060 : 1120;
  const cardH = hasBanner ? 630 : 640;
  
  const commentY = hasBanner ? 1445 : 1500;
  const idBoxY = hasBanner ? 1505 : 1565;
  const subY = hasBanner ? 1655 : 1715;
  const footerY = hasBanner ? 1720 : 1835;
  const bannerY = 1760;

  // Sub-filtros Condicionais Otimizados
  const discountFilter = discount
    ? `drawbox=x=720:y=${cardY + 35}:w=250:h=65:color=${accent}@1:t=fill,` +
      `drawtext=text='${discount}':fontcolor=white:fontsize=34:x=720+(250-text_w)/2:y=${cardY + 51}:fontfile=Arial:style=Bold,`
    : '';

  const oldPriceFilter = old
    ? `drawtext=text='${old}':fontcolor=${muted}:fontsize=32:x=(w-text_w)/2:y=${cardY + 130}:shadowcolor=black@0.50:shadowx=1:shadowy=1,` +
      `drawbox=x=(w-200)/2:y=${cardY + 148}:w=200:h=3:color=${accent}@0.85:t=fill,`
    : '';

  const filters = [
    // 1. Estilização do Fundo Premium (Efeito Cinema)
    `[0:v]split=2[bgsrc][prodsrc]`,
    `[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=35:luma_power=3,eq=brightness=-0.45:saturation=1.15:contrast=1.15[bgblur]`,
    `[prodsrc]scale=920:${productMaxH}:force_original_aspect_ratio=decrease,format=rgba[prod]`,
    
    hasBanner ? `[1:v]scale=1080:-1:force_original_aspect_ratio=increase,crop=1080:min(150\\,ih):0:0[banner]` : null,
    
    `[bgblur]drawbox=x=0:y=0:w=1080:h=1920:color=${bg}@0.50:t=fill[base0]`,
    
    // 2. Topo Corporativo Limpo
    `[base0]` +
      `drawbox=x=0:y=0:w=1080:h=160:color=black@0.65:t=fill,` +
      `drawbox=x=45:y=45:w=410:h=70:color=${yellow}@1:t=fill,` +
      `drawtext=text='${badge}':fontcolor=black:fontsize=30:x=45+(410-text_w)/2:y=66:fontfile=Arial:style=Bold,` +
      `drawtext=text='${brand}':fontcolor=${text}:fontsize=32:x=520:y=65:shadowcolor=black@0.80:shadowx=2:shadowy=2:fontfile=Arial:style=Bold,` +
      `drawbox=x=0:y=158:w=1080:h=3:color=${yellow}@0.40:t=fill[base1]`,
      
    // 3. Palco Central do Produto com Flutuação Orgânica (Gera dinamismo rápido)
    `[base1]` +
      `drawbox=x=80:y=${productY + 40}:w=920:h=${productMaxH - 60}:color=black@0.35:t=fill,` +
      `drawbox=x=120:y=${productY + 80}:w=840:h=${productMaxH - 140}:color=${goldSoft}@0.25:t=fill[base2]`,
      
    `[base2][prod]overlay=x=(W-w)/2:y=${productY}+6*sin(1.8*PI*t/3.5):eval=frame[stage1]`,
    
    // 4. Card Comercial Estilo Aplicativo Moderno (Glassmorphism simulado)
    `[stage1]` +
      `drawbox=x=40:y=${cardY + 15}:w=1000:h=${cardH}:color=black@0.50:t=fill,` + 
      `drawbox=x=50:y=${cardY}:w=980:h=${cardH}:color=${card}@0.96:t=fill,` +     
      `drawbox=x=50:y=${cardY}:w=980:h=${cardH}:color=white@0.05:t=2,` +         
      `drawbox=x=50:y=${cardY}:w=980:h=6:color=${yellow}@1:t=fill[stage2]`,       
      
    // 5. Exibição da Oferta e Copywriting
    `[stage2]` +
      `drawtext=text='SÓ HOJE POR:':fontcolor=${yellow}:fontsize=34:x=90:y=${cardY + 54}:fontfile=Arial:style=Bold,` +
      discountFilter +
      oldPriceFilter +
      `drawtext=text='${price}':fontcolor=${yellow}:fontsize=${priceFontSize}:x=(w-text_w)/2:y=${cardY + 195}:shadowcolor=black@0.95:shadowx=3:shadowy=3:fontfile=Arial:style=Bold,` +
      `drawtext=text='GARANTA O SEU ANTES QUE ACABE':fontcolor=${text}:fontsize=28:x=(w-text_w)/2:y=${cardY + 325}:fontfile=Arial:style=Italic,` +
      
      // 6. Bloco de CTA Matador (Gera gatilho mental para digitação do ID nos comentários)
      `drawtext=text='COMENTE ABAIXO':fontcolor=${text}:fontsize=42:x=(w-text_w)/2:y=${commentY}:shadowcolor=black@0.90:shadowx=2:shadowy=2:fontfile=Arial:style=Bold,` +
      
      `drawbox=x=210:y=${idBoxY}:w=660:h=120:color=black@0.40:t=fill,` +
      `drawbox=x=220:y=${idBoxY - 6}:w=640:h=120:color=${yellow}@1:t=fill,` +
      `drawbox=x=220:y=${idBoxY - 6}:w=640:h=120:color=white@0.45:t=4:enable='lt(mod(t\\,1.2)\\,0.35)',` +
      `drawtext=text='QUERO ${idNumber}':fontcolor=black:fontsize=68:x=(w-text_w)/2:y=${idBoxY + 20}:fontfile=Arial:style=Bold,` +
      
      `drawtext=text='PARA RECEBER O LINK NO DIRECT':fontcolor=${text}:fontsize=34:x=(w-text_w)/2:y=${subY}:shadowcolor=black@0.80:fontfile=Arial:style=Bold,` +
      
      // Rodapé Institucional de Credibilidade
      `drawtext=text='✓ COMPRA 100% SEGURA':fontcolor=${muted}:fontsize=26:x=75:y=${footerY}:fontfile=Arial,` +
      `drawtext=text='${brand}':fontcolor=${muted}:fontsize=26:x=w-text_w-75:y=${footerY}:fontfile=Arial:style=Bold[stage3]`,

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
// ROTAS DO SERVIDOR (ENDPOINTS)
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
      brand_badge: body.brand_badge || 'OFERTA IMPERDÍVEL',
      bg_color: body.bg_color || '0x0A0A0C',
      primary_color: body.primary_color || '0xFFE600',
      secondary_color: body.secondary_color || '0x1F1F24',
      accent_color: body.accent_color || '0xFA2A46',
      text_color: body.text_color || 'white',
      muted_color: body.muted_color || '0xA0A0AB',
      panel_color: body.panel_color || '0x121216'
    };

    console.log(`[create-reel] Geração Otimizada iniciada: id=${produtoId} d=${duration}s`);

    await buildReel(data, outPath);

    res.json({
      ok: true,
      produto_id: produtoId,
      video_url: `${PUBLIC_BASE_URL}/reels/${fileName}`,
      filename: fileName,
      elapsed_ms: Date.now() - start
    });

  } catch (err) {
    console.error('[create-reel] Erro em produção:', err.message, err.stderr || '');

    res.status(err.statusCode || 500).json({
      ok: false,
      error: err.publicCode || 'VIDEO_CREATION_FAILED',
      message: err.statusCode ? err.message : 'Falha ao criar o vídeo promocional.',
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

    // Exclusão concorrente ultrarrápida usando Promise.all
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

// Inicialização do Servidor Express
app.listen(PORT, () => {
  console.log(`\x1b[32m[REELS-ENGINE]\x1b[0m Ativo com sucesso: ${SERVICE_NAME} v${VERSION} na porta ${PORT}`);
});
