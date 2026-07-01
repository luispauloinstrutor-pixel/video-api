# Reels Engine — Achei da Hora / Radar de Ofertas

Motor multimarcas para gerar Reels, Shorts e vídeos verticais.

## Endpoints

### GET /health

### GET /templates

### POST /create-reel

Headers:
```txt
x-api-key: acheidahora123
```

Body exemplo:

```json
{
  "produto_id": "680",
  "image_url": "https://http2.mlstatic.com/...",
  "preco": "POR R$ 29,90",
  "preco_original_text": "DE R$ 34,97",
  "comentario": "ID 680",
  "desconto": "14% OFF",
  "template": "premium",
  "brand_name": "Radar de Ofertas",
  "brand_badge": "OFERTA RELÂMPAGO",
  "primary_color": "yellow",
  "accent_color": "red",
  "bg_color": "black",
  "text_color": "white"
}
```

Com banner da marca:

```json
{
  "produto_id": "680",
  "image_url": "https://http2.mlstatic.com/...",
  "preco": "POR R$ 29,90",
  "comentario": "ID 680",
  "desconto": "14% OFF",
  "template": "premium",
  "brand_name": "Achei da Hora",
  "brand_banner_url": "https://sua-url-publica/banner.png"
}
```

Templates:
- premium
- mercadolivre
- dark
- shopee
