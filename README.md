# WhatsApp Sales Bot

Bot de vendas para WhatsApp com Evolution API e Sigilo Pay.

## Modo atual

O fluxo está em `BOT_FLOW_MODE=test` por padrão, para facilitar a validação antes de ligar a cobrança real.

## Arquivos principais

- `index.js`: servidor Express e webhooks.
- `services/evolutionApi.js`: envio de mensagens e mídia.
- `services/sigiloPay.js`: criação de cobranças e leitura do webhook.

## Variáveis de ambiente

Copie o conteúdo de `.env` para as variáveis do Railway.

## Deploy no Railway

1. Crie um novo projeto no Railway.
2. Conecte este repositório GitHub.
3. Configure as variáveis de ambiente no painel do Railway.
4. Aplique o `Start Command` como `npm start` se o Railway não detectar automaticamente.
5. Publique o serviço.

## Deploy no GitHub

1. Faça login no GitHub CLI.
2. Crie o repositório remoto.
3. Faça o push da branch principal.

