# Media Service — Achei da Hora

API para gerar vídeo MP4 vertical para Instagram Reels usando FFmpeg.

## Endpoints

### GET /health
Testa se a API está online.

### POST /create-reel
Cria um MP4 e retorna `video_url`.

Headers:
- `x-api-key: SUA_CHAVE` se você configurar API_KEY.

Body exemplo:

```json
{
  "produto_id": "680",
  "image_url": "https://http2.mlstatic.com/...",
  "titulo": "Produto teste",
  "preco": "POR R$ 29,90",
  "comentario": "COMENTE 680",
  "desconto": "14% OFF"
}
```

Resposta:

```json
{
  "ok": true,
  "produto_id": "680",
  "video_url": "https://seu-dominio.com/reels/oferta_680_123.mp4"
}
```

## Variáveis de ambiente

```env
PORT=3000
PUBLIC_BASE_URL=https://seu-dominio.com
API_KEY=sua-chave-secreta
OUTPUT_DIR=/app/public/reels
TMP_DIR=/app/tmp
```
