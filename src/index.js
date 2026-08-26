const express = require('express')
const cors = require('cors')
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const path = require('path')
const fs = require('fs')

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3001
const AUTH_DIR = path.join(__dirname, 'auth_state')

let sock = null
let qrCode = null
let connectionStatus = 'disconnected'
let connectedPhone = null
let messageQueue = []
let lastActivity = Date.now()
let keepaliveInterval = null

async function connectWhatsApp() {
  try {
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true })
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      browser: ['VagaZaps', 'Chrome', '4.0'],
      markOnlineOnConnect: false,
      connectTimeout: 30000,
      keepAliveInterval: 25000,
    })

    if (keepaliveInterval) clearInterval(keepaliveInterval)
    keepaliveInterval = setInterval(() => {
      if (sock && sock.ws && sock.ws.readyState === 1) {
        sock.ws.ping()
        console.log('[WhatsApp] Keepalive ping sent')
      } else if (connectionStatus === 'connected') {
        console.log('[WhatsApp] WebSocket dead but status=connected, reconnecting...')
        connectionStatus = 'disconnected'
        setTimeout(connectWhatsApp, 3000)
      }
    }, 30000)

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        qrCode = qr
        connectionStatus = 'qr_ready'
        console.log('[WhatsApp] QR Code received - scan to connect')
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut
        
        console.log(`[WhatsApp] Connection closed. Status: ${statusCode}. Reconnect: ${shouldReconnect}`)
        
        if (statusCode === DisconnectReason.loggedOut) {
          connectionStatus = 'logged_out'
          qrCode = null
          connectedPhone = null
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true })
          }
        } else {
          connectionStatus = 'disconnected'
          qrCode = null
          setTimeout(connectWhatsApp, 3000)
        }
      }

      if (connection === 'open') {
        connectionStatus = 'connected'
        qrCode = null
        connectedPhone = sock.user?.id?.replace(/:.*@/, '@').split('@')[0] || null
        lastActivity = Date.now()
        console.log(`[WhatsApp] Connected! Phone: ${connectedPhone}`)
      }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', ({ messages }) => {
      lastActivity = Date.now()
      for (const msg of messages) {
        if (!msg.key.fromMe && msg.message) {
          console.log(`[WhatsApp] Message from ${msg.key.remoteJid}: ${msg.message.conversation || msg.message.extendedTextMessage?.text || '[media]'}`)
        }
      }
    })

    sock.ev.on('messages.update', (updates) => {
      for (const update of updates) {
        if (update.update?.status) {
          const status = update.update.status
          console.log(`[WhatsApp] Message status: ${update.key.id} -> ${status}`)
        }
      }
    })
  } catch (error) {
    console.error('[WhatsApp] Connection error:', error)
    connectionStatus = 'error'
    setTimeout(connectWhatsApp, 5000)
  }
}

function isSocketAlive() {
  return sock && sock.ws && sock.ws.readyState === 1
}

app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    phone: connectedPhone,
    hasQr: !!qrCode,
    alive: isSocketAlive(),
    lastActivity: new Date(lastActivity).toISOString(),
    uptime: Math.floor(process.uptime()),
  })
})

app.get('/api/qr', (req, res) => {
  if (!qrCode) {
    return res.json({ qr: null, status: connectionStatus })
  }
  res.json({ qr: qrCode, status: connectionStatus })
})

app.post('/api/connect', async (req, res) => {
  if (connectionStatus === 'connected' && isSocketAlive()) {
    return res.json({ success: true, message: 'Already connected', phone: connectedPhone })
  }

  if (connectionStatus === 'qr_ready' && qrCode) {
    return res.json({ success: true, message: 'QR code ready to scan', status: connectionStatus })
  }

  try {
    connectionStatus = 'disconnected'
    await connectWhatsApp()
    res.json({ success: true, message: 'Connection initiated', status: connectionStatus })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

app.post('/api/reconnect', async (req, res) => {
  try {
    if (sock) {
      sock.end()
      sock = null
    }
    connectionStatus = 'disconnected'
    qrCode = null
    connectedPhone = null
    await connectWhatsApp()
    res.json({ success: true, message: 'Reconnecting...', status: connectionStatus })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

app.post('/api/send', async (req, res) => {
  if (connectionStatus !== 'connected' || !sock) {
    return res.status(400).json({ success: false, error: 'WhatsApp not connected' })
  }

  if (!isSocketAlive()) {
    console.log('[WhatsApp] Socket dead, attempting reconnect...')
    connectionStatus = 'disconnected'
    connectWhatsApp()
    return res.status(400).json({ success: false, error: 'Connection stale, reconnecting...' })
  }

  const { phone, message } = req.body

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'phone and message are required' })
  }

  try {
    const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net'
    console.log(`[WhatsApp] Sending to ${jid}...`)
    const result = await sock.sendMessage(jid, { text: message })
    lastActivity = Date.now()
    console.log(`[WhatsApp] Message sent to ${phone}, id: ${result.key.id}`)

    messageQueue.push({
      to: phone,
      message,
      sentAt: new Date().toISOString(),
      messageId: result.key.id,
    })

    res.json({ success: true, messageId: result.key.id })
  } catch (error) {
    console.error('[WhatsApp] Send error:', error.message || error)
    res.status(500).json({ success: false, error: error.message || String(error) })
  }
})

app.post('/api/send-batch', async (req, res) => {
  if (connectionStatus !== 'connected' || !sock) {
    return res.status(400).json({ success: false, error: 'WhatsApp not connected' })
  }

  if (!isSocketAlive()) {
    return res.status(400).json({ success: false, error: 'Connection stale' })
  }

  const { messages } = req.body

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ success: false, error: 'messages array is required' })
  }

  const results = []

  for (const { phone, message } of messages) {
    try {
      const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net'
      const result = await sock.sendMessage(jid, { text: message })
      results.push({ phone, success: true, messageId: result.key.id })
      lastActivity = Date.now()

      await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000))
    } catch (error) {
      results.push({ phone, success: false, error: error.message })
    }
  }

  res.json({ success: true, results })
})

app.post('/api/disconnect', async (req, res) => {
  try {
    if (keepaliveInterval) clearInterval(keepaliveInterval)
    if (sock) {
      sock.end()
      sock = null
    }
    qrCode = null
    connectionStatus = 'disconnected'
    connectedPhone = null
    res.json({ success: true, message: 'Disconnected' })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

app.get('/api/history', (req, res) => {
  res.json({ messages: messageQueue.slice(-50) })
})

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), status: connectionStatus, alive: isSocketAlive() })
})

connectWhatsApp()

app.listen(PORT, () => {
  console.log(`[VagaZaps WhatsApp] Server running on port ${PORT}`)
})
