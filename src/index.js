const express = require('express')
const cors = require('cors')
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')
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
      browser: ['VagaZaps', 'Safari', '3.0'],
      markOnlineOnConnect: false,
    })

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
        console.log(`[WhatsApp] Connected! Phone: ${connectedPhone}`)
      }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        if (!msg.key.fromMe && msg.message) {
          console.log(`[WhatsApp] Message from ${msg.key.remoteJid}: ${msg.message.conversation || msg.message.extendedTextMessage?.text || '[media]'}`)
        }
      }
    })
  } catch (error) {
    console.error('[WhatsApp] Connection error:', error)
    connectionStatus = 'error'
    setTimeout(connectWhatsApp, 5000)
  }
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
  if (connectionStatus === 'connected') {
    return res.json({ success: true, message: 'Already connected', phone: connectedPhone })
  }

  if (connectionStatus === 'qr_ready' && qrCode) {
    return res.json({ success: true, message: 'QR code ready to scan', status: connectionStatus })
  }

  try {
    await connectWhatsApp()
    res.json({ success: true, message: 'Connection initiated', status: connectionStatus })
  } catch (error) {
    res.status(500).json({ success: false, error: error.message })
  }
})

app.post('/api/send', async (req, res) => {
  if (connectionStatus !== 'connected' || !sock) {
    return res.status(400).json({ success: false, error: 'WhatsApp not connected' })
  }

  const { phone, message } = req.body

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'phone and message are required' })
  }

  try {
    const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net'
    const result = await sock.sendMessage(jid, { text: message })
    console.log(`[WhatsApp] Message sent to ${phone}`)

    messageQueue.push({
      to: phone,
      message,
      sentAt: new Date().toISOString(),
      messageId: result.key.id,
    })

    res.json({ success: true, messageId: result.key.id })
  } catch (error) {
    console.error('[WhatsApp] Send error:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

app.post('/api/send-batch', async (req, res) => {
  if (connectionStatus !== 'connected' || !sock) {
    return res.status(400).json({ success: false, error: 'WhatsApp not connected' })
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

      await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000))
    } catch (error) {
      results.push({ phone, success: false, error: error.message })
    }
  }

  res.json({ success: true, results })
})

app.post('/api/disconnect', async (req, res) => {
  try {
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
  res.json({ ok: true, uptime: process.uptime() })
})

connectWhatsApp()

app.listen(PORT, () => {
  console.log(`[VagaZaps WhatsApp] Server running on port ${PORT}`)
})
