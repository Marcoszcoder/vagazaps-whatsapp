const express = require('express')
const cors = require('cors')
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const path = require('path')
const fs = require('fs')

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3001
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_state')

let sock = null
let qrCode = null
let connectionStatus = 'disconnected'
let connectedPhone = null
let messageQueue = []
let reconnecting = false
let connectPromise = null

async function connectWhatsApp() {
  if (reconnecting) return connectPromise
  reconnecting = true

  connectPromise = (async () => {
    try {
      if (sock) {
        try { sock.end(undefined, true) } catch {}
        sock = null
      }

      if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true })
      }

      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
      const { version } = await fetchLatestBaileysVersion()

      connectionStatus = 'connecting'
      console.log('[WhatsApp] Connecting...')

      sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        browser: ['VagaZaps', 'Chrome', '4.0'],
        markOnlineOnConnect: false,
        connectTimeout: 60000,
        keepAliveInterval: 30000,
        generateHighQualityLinkPreview: false,
      })

      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
          qrCode = qr
          connectionStatus = 'qr_ready'
          console.log('[WhatsApp] QR Code received')
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode
          console.log(`[WhatsApp] Closed. code=${statusCode}`)

          if (statusCode === DisconnectReason.loggedOut) {
            connectionStatus = 'logged_out'
            qrCode = null
            connectedPhone = null
            try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }) } catch {}
          } else if (statusCode === DisconnectReason.connectionClosed ||
                     statusCode === DisconnectReason.connectionLost ||
                     statusCode === DisconnectReason.timedOut) {
            connectionStatus = 'disconnected'
            qrCode = null
            reconnecting = false
            setTimeout(() => connectWhatsApp(), 5000)
          } else {
            connectionStatus = 'disconnected'
            qrCode = null
            reconnecting = false
            setTimeout(() => connectWhatsApp(), 10000)
          }
        }

        if (connection === 'open') {
          connectionStatus = 'connected'
          qrCode = null
          connectedPhone = sock.user?.id?.replace(/:.*@/, '@').split('@')[0] || null
          reconnecting = false
          console.log(`[WhatsApp] Connected! Phone: ${connectedPhone}`)
        }
      })

      sock.ev.on('creds.update', saveCreds)

      sock.ev.on('messages.upsert', ({ messages }) => {
        for (const msg of messages) {
          if (!msg.key.fromMe && msg.message) {
            console.log(`[WhatsApp] Msg from ${msg.key.remoteJid}`)
          }
        }
      })
    } catch (error) {
      console.error('[WhatsApp] Connect error:', error.message)
      connectionStatus = 'error'
      reconnecting = false
      setTimeout(() => connectWhatsApp(), 10000)
    }
  })()

  return connectPromise
}

async function ensureConnected() {
  if (connectionStatus === 'connected' && sock && sock.ws && sock.ws.readyState === 1) {
    return true
  }
  if (connectionStatus !== 'connected') {
    await connectWhatsApp()
    await new Promise(r => setTimeout(r, 3000))
    return connectionStatus === 'connected'
  }
  return false
}

app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    phone: connectedPhone,
    hasQr: !!qrCode,
  })
})

app.get('/api/qr', (req, res) => {
  if (!qrCode) {
    return res.json({ qr: null, status: connectionStatus })
  }
  res.json({ qr: qrCode, status: connectionStatus })
})

app.post('/api/connect', async (req, res) => {
  try {
    await connectWhatsApp()
    res.json({ success: true, message: 'Connection initiated', status: connectionStatus })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

app.post('/api/send', async (req, res) => {
  const { phone, message } = req.body

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'phone and message required' })
  }

  const connected = await ensureConnected()
  if (!connected) {
    return res.status(400).json({ success: false, error: 'WhatsApp nao conectado. Escaneie o QR code.' })
  }

  try {
    const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net'
    console.log(`[WhatsApp] Sending to ${jid}...`)
    const result = await sock.sendMessage(jid, { text: message })
    console.log(`[WhatsApp] Sent! id=${result.key.id}`)

    messageQueue.push({
      to: phone,
      message: message.substring(0, 100) + '...',
      sentAt: new Date().toISOString(),
      messageId: result.key.id,
    })

    res.json({ success: true, messageId: result.key.id })
  } catch (error) {
    console.error('[WhatsApp] Send error:', error.message)

    if (error.message.includes('Connection') || error.message.includes('not open')) {
      connectionStatus = 'disconnected'
      reconnecting = false
      connectWhatsApp()
    }

    res.status(500).json({ success: false, error: error.message })
  }
})

app.post('/api/send-batch', async (req, res) => {
  const { messages } = req.body

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ success: false, error: 'messages array required' })
  }

  const connected = await ensureConnected()
  if (!connected) {
    return res.status(400).json({ success: false, error: 'WhatsApp nao conectado' })
  }

  const results = []

  for (const { phone, message } of messages) {
    try {
      const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net'
      const result = await sock.sendMessage(jid, { text: message })
      results.push({ phone, success: true, messageId: result.key.id })
      console.log(`[WhatsApp] Batch sent to ${phone}`)
      await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 2000))
    } catch (error) {
      results.push({ phone, success: false, error: error.message })
      console.error(`[WhatsApp] Batch fail to ${phone}: ${error.message}`)
    }
  }

  res.json({ success: true, results })
})

app.post('/api/disconnect', async (req, res) => {
  try {
    if (sock) {
      try { sock.end(undefined, true) } catch {}
      sock = null
    }
    qrCode = null
    connectionStatus = 'disconnected'
    connectedPhone = null
    reconnecting = false
    res.json({ success: true, message: 'Disconnected' })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

app.get('/api/history', (req, res) => {
  res.json({ messages: messageQueue.slice(-50) })
})

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: Math.floor(process.uptime()), status: connectionStatus })
})

connectWhatsApp()

app.listen(PORT, () => {
  console.log(`[VagaZaps WhatsApp] Running on port ${PORT}`)
})
