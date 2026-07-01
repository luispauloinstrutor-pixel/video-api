# Reels Engine Pro v3

Visual novo:
- Informações sobem para o centro.
- CTA maior e legível.
- Produto com mais espaço.
- Rodapé por `brand_banner_url`.
- Marca não fica fixa na API.
- Endpoint para apagar vídeos: DELETE /reels.

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
  "panel_color": "black",
  "text_color": "white",
  "duration": 8
}
```

## DELETE /reels

Apaga todos os MP4 gerados.
