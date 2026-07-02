# Reels Engine Pro v4

Correções:
- Remove duplicidade de "COMENTE".
- CTA agora sempre fica:
  COMENTE
  ID 347
- Layout mais limpo.
- Card de preço/CTA mais alto e legível.
- Menos cara de script automático.
- Marca continua dinâmica pelo n8n.
- Rodapé pode vir por `brand_banner_url`.

## Body recomendado

```json
{
  "produto_id": "347",
  "image_url": "https://...",
  "preco": "POR R$ 169,00",
  "preco_original_text": "DE R$ 229,00",
  "comentario": "ID 347",
  "desconto": "26% OFF",
  "brand_name": "📡 Radar de Ofertas 🔥",
  "brand_badge": "OFERTA DO DIA",
  "brand_banner_url": "https://url-publica-do-rodape.png",
  "primary_color": "yellow",
  "accent_color": "red",
  "bg_color": "black",
  "panel_color": "0x111111",
  "text_color": "white",
  "duration": 8
}
```

## Limpeza

`DELETE /reels` apaga todos os MP4.
