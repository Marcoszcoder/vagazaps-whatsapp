const express = require('express')
const cors = require('cors')
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const path = require('path')
const fs = require('fs')

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

const PORT = process.env.PORT || 3001
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_state')

let sock = null
let qrCode = null
let connectionStatus = 'disconnected'
let connectedPhone = null
let messageQueue = []
let reconnectTimer = null

function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '')
  if (digits.startsWith('55')) return digits
  return '55' + digits
}

function isSocketAlive() {
  try {
    return sock && sock.ws && sock.ws.readyState === 1
  } catch {
    return false
  }
}

function scheduleReconnect(delay) {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    if (connectionStatus !== 'connected') {
      console.log(`[WhatsApp] Auto-reconnecting in ${delay}ms...`)
      connectWhatsApp()
    }
  }, delay)
}

async function connectWhatsApp() {
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
        sock = null

        if (statusCode === DisconnectReason.loggedOut) {
          connectionStatus = 'logged_out'
          qrCode = null
          connectedPhone = null
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }) } catch {}
        } else {
          connectionStatus = 'disconnected'
          qrCode = null
          scheduleReconnect(5000)
        }
      }

      if (connection === 'open') {
        connectionStatus = 'connected'
        qrCode = null
        connectedPhone = sock.user?.id?.replace(/:.*@/, '@').split('@')[0] || null
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
    scheduleReconnect(10000)
  }
}

app.get('/api/status', (req, res) => {
  const alive = isSocketAlive()
  res.json({
    status: alive ? 'connected' : connectionStatus,
    phone: connectedPhone,
    hasQr: !!qrCode,
  })
})

app.get('/api/qr', (req, res) => {
  res.json({ qr: qrCode, status: connectionStatus })
})

app.post('/api/connect', async (req, res) => {
  try {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    await connectWhatsApp()
    res.json({ success: true, status: connectionStatus })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

app.post('/api/send', async (req, res) => {
  const { phone, message } = req.body

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'phone and message required' })
  }

  if (!isSocketAlive()) {
    console.log(`[WhatsApp] Send blocked: socket not alive. status=${connectionStatus} sock=${!!sock}`)
    if (connectionStatus !== 'connected') {
      return res.status(400).json({ success: false, error: 'WhatsApp nao conectado. Escaneie o QR code.' })
    }
    return res.status(400).json({ success: false, error: 'WhatsApp desconectou. Reconectando...' })
  }

  try {
    const jid = normalizePhone(phone) + '@s.whatsapp.net'
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

    if (error.message.includes('Connection') || error.message.includes('not open') || error.message.includes('closed')) {
      connectionStatus = 'disconnected'
      scheduleReconnect(5000)
    }

    res.status(500).json({ success: false, error: error.message })
  }
})

app.post('/api/send-batch', async (req, res) => {
  const { messages } = req.body

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ success: false, error: 'messages array required' })
  }

  if (!isSocketAlive()) {
    return res.status(400).json({ success: false, error: 'WhatsApp nao conectado' })
  }

  const results = []

  for (const { phone, message } of messages) {
    try {
      const jid = normalizePhone(phone) + '@s.whatsapp.net'
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
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (sock) {
      try { sock.end(undefined, true) } catch {}
      sock = null
    }
    qrCode = null
    connectionStatus = 'disconnected'
    connectedPhone = null
    res.json({ success: true })
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
