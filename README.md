# Sifras Invest - Dashboard de Volatilidade

Este projeto foi desenvolvido para monitorar as moedas mais explosivas do mercado cripto em tempo real, utilizando dados oficiais da Binance.

## Funcionalidades
- **Filtro de Ranking Positivo:** Apenas moedas que tiveram alta nas últimas 24h.
- **Top 20 Volatilidade:** Cálculo em tempo real da oscilação entre a mínima e a máxima do dia (`(High - Low) / Low`).
- **Ticker de Preços Live:** Barra de rolagem superior com os preços do Top 10 em tempo real.
- **Design Ultra-Premium:** Interface modernizada com Mesh Gradients, efeito Glassmorphism e Grid Futurista.
- **Dados em Tempo Real:** Atualização automática a cada 2-5 segundos com telemetria direta da Binance.

## Como Executar
1. Abra o arquivo `index.html` em qualquer navegador moderno.
2. Certifique-se de estar conectado à internet para consumir os dados da API da Binance.

## Lógica de Negócio
- A volatilidade é calculada como a variação percentual absoluta entre o preço mais alto e o mais baixo das últimas 24 horas.
- Filtramos apenas pares com liquidez (Volume > 1M USDT) para garantir que as moedas exibidas sejam operáveis.
