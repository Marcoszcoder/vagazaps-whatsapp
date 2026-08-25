# VagaZaps WhatsApp Backend

Backend para integração WhatsApp usando Baileys (protocolo multi-device).

## Setup

```bash
npm install
npm start
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Status da conexão WhatsApp |
| GET | `/api/qr` | Obter QR code para escanear |
| POST | `/api/connect` | Iniciar conexão WhatsApp |
| POST | `/api/send` | Enviar mensagem individual |
| POST | `/api/send-batch` | Enviar múltiplas mensagens |
| POST | `/api/disconnect` | Desconectar WhatsApp |
| GET | `/api/history` | Histórico de mensagens enviadas |
| GET | `/health` | Health check |

## Deploy no Render

1. Crie um repositório no GitHub com este código
2. Conecte no Render.com
3. Crie um "New Web Service"
4. Selecione o repositório
5. Deploy automático

## Fluxo de Conexão

1. Frontend chama `POST /api/connect`
2. Backend inicia conexão WhatsApp
3. Frontend faz polling em `GET /api/qr` para obter QR code
4. Usuário escaneia QR code com WhatsApp
5. Backend detecta conexão e retorna status `connected`
6. Frontend pode enviar mensagens via `POST /api/send`
