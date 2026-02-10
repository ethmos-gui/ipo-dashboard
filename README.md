# IPO Dashboard — SBB

Dashboard de análise de performance de inventário (Inventory Performance Optimization) para a Sociedade Bíblica do Brasil.

## Funcionalidades

- **Análise IPO** com 5 componentes: Margem, Tendência, Preço, Contribuição, Giro
- **Sparklines** de vendas mensais por produto (formato Mes/Ano MAAAA)
- **Capas dos produtos** via API Metabooks
- **Classificação automática** de estoque: Saudável, Moderada, Agressiva, Liquidação
- **Sugestão de preço promocional** por tier
- **Histórico** de análises salvas no navegador
- **Seletor de período** (3, 6, 12, 18, 24 meses ou todos)
- **Exportação CSV** dos resultados

## Deploy na Vercel

### Opção 1: Via GitHub
1. Crie um repositório no GitHub
2. Faça push deste projeto
3. Em [vercel.com](https://vercel.com), importe o repositório
4. A Vercel detecta Vite automaticamente — clique "Deploy"

### Opção 2: Via CLI
```bash
npm install
npx vercel
```

### Opção 3: Local
```bash
npm install
npm run dev
```
Acesse http://localhost:5173

## Arquivos CSV esperados

### Vendas (obrigatório)
| Coluna | Exemplo |
|--------|---------|
| Código | 7899938407691 |
| Código SBB | RC06BAP EST APLICACAO PESSOAL |
| Soma de Qtd. | 6 |
| Média de Valor unitário | 140.3708 |
| Média de Preço de lista | 224.95 |
| Média de Custo unitário | 58.67818 |
| Mes/Ano | 102024 |

### Estoque (opcional)
CSV com: Código, 3º Nº de Item (ISBN), Qtd Disponível, Descrição.
