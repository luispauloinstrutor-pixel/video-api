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
app.use(express.json({ limit: '30mb' }));
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

function pick(value, fallback) {
  return value === undefined || value === null || value === '' ? fallback : value;
}

function color(value, fallback) {
  const v = String(value || '').trim();
  if (!v) return fallback;
  return v.replace(/[^a-zA-Z0-9#@.]/g, '');
}

function execFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 240000 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

function baseVideoArgs(imageUrl, duration) {
  return [
    '-y',
    '-loop', '1',
    '-t', String(duration),
    '-i', imageUrl
  ];
}

function outputArgs(outPath) {
  return [
    '-r', '30',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath
  ];
}

function buildPremiumFilter(data) {
  const bg = color(data.bg_color, 'black');
  const primary = color(data.primary_color, 'yellow');
  const accent = color(data.accent_color, 'red');
  const text = color(data.text_color, 'white');

  const brand = cleanText(data.brand_name || 'OFERTAS', 40).toUpperCase();
  const badge = cleanText(data.brand_badge || 'OFERTA RELÂMPAGO', 28).toUpperCase();
  const price = cleanText(data.preco || '', 50).toUpperCase();
  const oldPrice = cleanText(data.preco_original_text || '', 40).toUpperCase();
  const discount = cleanText(data.desconto || '', 35).toUpperCase();
  const comment = cleanText(data.comentario || `ID ${data.produto_id}`, 35).toUpperCase();

  const lines = [
    // produto com zoom leve, centralizado
    `scale=1188:1540:force_original_aspect_ratio=increase`,
    `crop=1080:1320`,
    `zoompan=z='min(zoom+0.0015,1.09)':d=270:s=1080x1320:fps=30`,
    `pad=1080:1920:0:170:color=${bg}`,

    // topo
    `drawbox=x=0:y=0:w=1080:h=170:color=${bg}@0.92:t=fill`,
    `drawbox=x=38:y=34:w=480:h=74:color=${primary}@1:t=fill`,
    `drawtext=text='${badge}':fontcolor=black:fontsize=38:x=70:y=51`,
    `drawtext=text='${brand}':fontcolor=${text}:fontsize=42:x=60:y=122`,

    // selo desconto
    discount ? `drawbox=x=780:y=210:w=245:h=105:color=${accent}@0.92:t=fill` : null,
    discount ? `drawtext=text='${discount}':fontcolor=${text}:fontsize=44:x=810:y=242` : null,

    // painel preço + CTA
    `drawbox=x=0:y=1420:w=1080:h=500:color=${bg}@0.92:t=fill`,
    oldPrice ? `drawtext=text='${oldPrice}':fontcolor=gray:fontsize=38:x=(w-text_w)/2:y=1468` : null,
    `drawtext=text='${price}':fontcolor=${primary}:fontsize=88:x=(w-text_w)/2:y=1532`,
    `drawtext=text='👇 COMENTE':fontcolor=${text}:fontsize=54:x=(w-text_w)/2:y=1652`,
    `drawtext=text='${comment}':fontcolor=${primary}:fontsize=100:x=(w-text_w)/2:y=1720`,
    `drawtext=text='QUE EU TE MANDO O LINK':fontcolor=${text}:fontsize=34:x=(w-text_w)/2:y=1848`,
    `format=yuv420p`
  ];

  return lines.filter(Boolean).join(',');
}

function buildMercadoLivreFilter(data) {
  const bg = color(data.bg_color, 'black');
  const primary = color(data.primary_color, 'yellow');
  const text = color(data.text_color, 'white');

  const brand = cleanText(data.brand_name || 'RADAR DE OFERTAS', 38).toUpperCase();
  const price = cleanText(data.preco || '', 50).toUpperCase();
  const discount = cleanText(data.desconto || '', 32).toUpperCase();
  const comment = cleanText(data.comentario || `ID ${data.produto_id}`, 35).toUpperCase();

  const lines = [
    `scale=1080:1320:force_original_aspect_ratio=decrease`,
    `pad=1080:1920:(ow-iw)/2:135:color=${bg}`,
    `drawbox=x=0:y=0:w=1080:h=140:color=${primary}@1:t=fill`,
    `drawtext=text='🔥 MAIS VENDIDO':fontcolor=black:fontsize=52:x=(w-text_w)/2:y=38`,
    discount ? `drawbox=x=40:y=230:w=260:h=105:color=${primary}@1:t=fill` : null,
    discount ? `drawtext=text='${discount}':fontcolor=black:fontsize=46:x=70:y=262` : null,
    `drawbox=x=0:y=1450:w=1080:h=470:color=${bg}@0.92:t=fill`,
    `drawtext=text='${price}':fontcolor=${primary}:fontsize=92:x=(w-text_w)/2:y=1518`,
    `drawtext=text='COMENTE':fontcolor=${text}:fontsize=54:x=(w-text_w)/2:y=1648`,
    `drawtext=text='${comment}':fontcolor=${primary}:fontsize=98:x=(w-text_w)/2:y=1718`,
    `drawtext=text='${brand}  |  OFERTA VERIFICADA':fontcolor=${text}:fontsize=34:x=(w-text_w)/2:y=1856`,
    `format=yuv420p`
  ];

  return lines.filter(Boolean).join(',');
}

function buildDarkFilter(data) {
  const bg = color(data.bg_color, 'black');
  const primary = color(data.primary_color, 'white');
  const accent = color(data.accent_color, 'yellow');
  const brand = cleanText(data.brand_name || 'OFERTAS', 40).toUpperCase();
  const price = cleanText(data.preco || '', 50).toUpperCase();
  const comment = cleanText(data.comentario || `ID ${data.produto_id}`, 35).toUpperCase();

  return [
    `scale=1080:1380:force_original_aspect_ratio=decrease`,
    `pad=1080:1920:(ow-iw)/2:180:color=${bg}`,
    `drawtext=text='${brand}':fontcolor=${primary}:fontsize=56:x=(w-text_w)/2:y=55`,
    `drawbox=x=0:y=1460:w=1080:h=460:color=${bg}@0.90:t=fill`,
    `drawtext=text='${price}':fontcolor=${primary}:fontsize=92:x=(w-text_w)/2:y=1538`,
    `drawtext=text='👇 COMENTE':fontcolor=${accent}:fontsize=58:x=(w-text_w)/2:y=1668`,
    `drawtext=text='${comment}':fontcolor=${accent}:fontsize=104:x=(w-text_w)/2:y=1744`,
    `format=yuv420p`
  ].join(',');
}

function buildShopeeFilter(data) {
  const bg = color(data.bg_color, 'black');
  const orange = color(data.primary_color, 'orange');
  const text = color(data.text_color, 'white');
  const brand = cleanText(data.brand_name || 'OFERTAS', 36).toUpperCase();
  const price = cleanText(data.preco || '', 50).toUpperCase();
  const comment = cleanText(data.comentario || `ID ${data.produto_id}`, 35).toUpperCase();
  const discount = cleanText(data.desconto || '', 30).toUpperCase();

  const lines = [
    `scale=1080:1340:force_original_aspect_ratio=decrease`,
    `pad=1080:1920:(ow-iw)/2:160:color=${bg}`,
    `drawbox=x=0:y=0:w=1080:h=160:color=${orange}@1:t=fill`,
    `drawtext=text='${brand}':fontcolor=white:fontsize=54:x=(w-text_w)/2:y=48`,
    discount ? `drawbox=x=760:y=220:w=270:h=105:color=${orange}@1:t=fill` : null,
    discount ? `drawtext=text='${discount}':fontcolor=white:fontsize=44:x=800:y=253` : null,
    `drawbox=x=0:y=1450:w=1080:h=470:color=${orange}@0.97:t=fill`,
    `drawtext=text='${price}':fontcolor=white:fontsize=90:x=(w-text_w)/2:y=1528`,
    `drawtext=text='COMENTE':fontcolor=white:fontsize=54:x=(w-text_w)/2:y=1658`,
    `drawtext=text='${comment}':fontcolor=white:fontsize=100:x=(w-text_w)/2:y=1728`,
    `drawtext=text='LINK AUTOMATICO NO DIRECT':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=1850`,
    `format=yuv420p`
  ];

  return lines.filter(Boolean).join(',');
}

function buildFilter(data) {
  const template = String(data.template || 'premium').toLowerCase();

  if (template === 'mercadolivre' || template === 'ml') return buildMercadoLivreFilter(data);
  if (template === 'dark') return buildDarkFilter(data);
  if (template === 'shopee') return buildShopeeFilter(data);

  return buildPremiumFilter(data);
}

async function buildWithBanner(data, outPath) {
  const bg = color(data.bg_color, 'black');
  const primary = color(data.primary_color, 'yellow');
  const accent = color(data.accent_color, 'red');
  const text = color(data.text_color, 'white');

  const price = cleanText(data.preco || '', 50).toUpperCase();
  const discount = cleanText(data.desconto || '', 35).toUpperCase();
  const comment = cleanText(data.comentario || `ID ${data.produto_id}`, 35).toUpperCase();

  // input 0 = produto, input 1 = banner/footer
  const filter = [
    `[0:v]scale=1080:1260:force_original_aspect_ratio=decrease,pad=1080:1260:(ow-iw)/2:(oh-ih)/2:color=${bg}[prod]`,
    `[1:v]scale=1080:-1:force_original_aspect_ratio=decrease,crop=1080:min(260\\,ih):0:0[brand]`,
    `color=c=${bg}:s=1080x1920:d=${data.duration || 9}[canvas]`,
    `[canvas][prod]overlay=0:120[tmp1]`,
    `[tmp1]drawbox=x=0:y=1350:w=1080:h=310:color=${bg}@0.92:t=fill,` +
      (discount ? `drawbox=x=50:y=1378:w=250:h=84:color=${accent}@0.92:t=fill,drawtext=text='${discount}':fontcolor=${text}:fontsize=42:x=78:y=1402,` : '') +
      `drawtext=text='${price}':fontcolor=${primary}:fontsize=86:x=(w-text_w)/2:y=1448,` +
      `drawtext=text='👇 COMENTE':fontcolor=${text}:fontsize=48:x=(w-text_w)/2:y=1540,` +
      `drawtext=text='${comment}':fontcolor=${primary}:fontsize=78:x=(w-text_w)/2:y=1588[tmp2]`,
    `[tmp2][brand]overlay=0:1660,format=yuv420p[out]`
  ].join(';');

  const args = [
    ...baseVideoArgs(data.image_url, data.duration || 9),
    '-loop', '1',
    '-t', String(data.duration || 9),
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
    service: 'reels-engine-achei-da-hora',
    version: '2.0.0',
    public_base_url: PUBLIC_BASE_URL || null
  });
});

app.get('/templates', (req, res) => {
  res.json({
    ok: true,
    templates: [
      { key: 'premium', description: 'Produto grande, preço forte e CTA gigante.' },
      { key: 'mercadolivre', description: 'Visual amarelo/preto inspirado em ofertas.' },
      { key: 'dark', description: 'Minimalista, elegante e escuro.' },
      { key: 'shopee', description: 'Visual laranja para campanhas agressivas.' }
    ],
    dynamic_fields: [
      'brand_name',
      'brand_banner_url',
      'brand_badge',
      'primary_color',
      'accent_color',
      'bg_color',
      'text_color',
      'template'
    ]
  });
});

app.post('/create-reel', requireApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const {
      produto_id,
      image_url
    } = body;

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

    const safeId = safeFileId(produto_id);
    const fileName = `reel_${String(body.template || 'premium').toLowerCase()}_${safeId}_${Date.now()}.mp4`;
    const outPath = path.join(OUTPUT_DIR, fileName);

    const data = {
      ...body,
      produto_id: safeId,
      duration: Number(pick(body.duration, 9)),
      comentario: cleanText(body.comentario || `ID ${safeId}`, 35).toUpperCase(),
      brand_name: cleanText(body.brand_name || 'OFERTAS', 40)
    };

    if (data.brand_banner_url) {
      await buildWithBanner(data, outPath);
    } else {
      const filter = buildFilter(data);
      const args = [
        ...baseVideoArgs(data.image_url, data.duration),
        '-vf', filter,
        ...outputArgs(outPath)
      ];

      await execFfmpeg(args);
    }

    const videoUrl = `${PUBLIC_BASE_URL}/reels/${fileName}`;

    return res.json({
      ok: true,
      produto_id: safeId,
      template: body.template || 'premium',
      brand_name: data.brand_name || null,
      used_brand_banner: Boolean(data.brand_banner_url),
      comment_text: data.comentario,
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
  console.log(`Reels Engine running on port ${PORT}`);
  console.log(`Public base URL: ${PUBLIC_BASE_URL || '(not set)'}`);
});
