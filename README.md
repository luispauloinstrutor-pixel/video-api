# Reels Engine Pro v5 — Template Achei Story

Correções:
- Usa uma arte base 1080x1920 como template.
- `image_url` continua sendo a imagem do produto.
- `template_url` é o fundo limpo do Reels/Story.
- Produto, desconto, título e preço entram por cima do template.
- O ID do produto continua sendo enviado em `produto_id`, mas não aparece mais para o cliente.
- CTA agora sempre fica:
  COMENTE
  EU QUERO
  QUE TE MANDO O LINK
- Layout mais parecido com arte manual.
- Menos cara de script automático.
- Marca pode ficar dentro do template.
- Rodapé antigo por `brand_banner_url` não é necessário nesse layout, mas pode continuar no layout antigo.

## Body recomendado

```json
{
  "layout": "achei_story",
  "template_url": "https://seudominio.com/assets/achei-story-base.png",

  "produto_id": "347",
  "image_url": "https://url-publica-da-imagem-do-produto.png",

  "titulo": "Batom Matte MAC Cosméticos",
  "preco": "Por R$ 169,00",
  "preco_original_text": "DE R$ 229,00",
  "desconto": "26% OFF",

  "comentario": "EU QUERO",
  "cta_text": "COMENTE",
  "cta_subtext": "QUE TE MANDO O LINK",

  "brand_name": "Achei da Hora",
  "brand_badge": "OFERTAS DO DIA",

  "primary_color": "yellow",
  "accent_color": "red",
  "bg_color": "black",
  "panel_color": "0x111111",
  "text_color": "white",

  "duration": 8
}
