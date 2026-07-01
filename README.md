# Reels Engine Leve — v2.1

Versão otimizada para não travar a VPS.

Mudanças:
- Remove `zoompan` pesado.
- Usa `-preset veryfast`.
- Usa `-crf 28`.
- Renderiza em 24 FPS.
- Duração limitada entre 5 e 10 segundos.
- Mantém marca dinâmica pelo n8n.
- Mantém CTA: `ID 680`.

## POST /create-reel

Header:

```txt
x-api-key: acheidahora123
```

Body:

```json
{
  "produto_id": "680",
  "image_url": "https://...",
  "preco": "POR R$ 29,90",
  "preco_original_text": "DE R$ 34,97",
  "comentario": "ID 680",
  "desconto": "14% OFF",
  "brand_name": "Radar de Ofertas",
  "brand_badge": "MAIS VENDIDO",
  "brand_banner_url": "https://url-publica-do-rodape.png",
  "primary_color": "yellow",
  "accent_color": "red",
  "bg_color": "black",
  "text_color": "white",
  "duration": 8
}
```
