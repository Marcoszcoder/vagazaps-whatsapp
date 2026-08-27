const express = require('express')
const cors = require('cors')
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const path = require('path')
const fs = require('fs')

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

const PORT = process.env.PORT || 3001
const AUTH_DIR = path.join(__dirname, '.wa_session')

let sock = null
let qrCode = null
let connectionStatus = 'disconnected'
let connectedPhone = null
let messageQueue = []
let reconnectAttempts = 0
const MAX_RECONNECT = 50

function normalizePhone(phone) {
  let digits = phone.replace(/\D/g, '')
  if (!digits) return ''
  if (!digits.startsWith('55')) digits = '55' + digits
  if (digits.length === 13) {
    const ddd = digits.substring(2, 4)
    const nine = digits.substring(4, 5)
    if (nine !== '9') {
      digits = digits.substring(0, 4) + '9' + digits.substring(4)
    }
  }
  return digits
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
    console.log(`[WA] Connecting... (attempt ${reconnectAttempts + 1})`)

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
        console.log('[WA] QR ready - scan with WhatsApp')
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        console.log(`[WA] Connection closed. code=${code}`)
        sock = null

        if (code === DisconnectReason.loggedOut) {
          connectionStatus = 'logged_out'
          qrCode = null
          connectedPhone = null
          reconnectAttempts = 0
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }) } catch {}
          console.log('[WA] Logged out - session cleared')
        } else {
          connectionStatus = 'disconnected'
          qrCode = null
          reconnectAttempts++
          if (reconnectAttempts <= MAX_RECONNECT) {
            const delay = Math.min(reconnectAttempts * 2000, 30000)
            console.log(`[WA] Reconnecting in ${delay}ms...`)
            setTimeout(() => connectWhatsApp(), delay)
          } else {
            console.log('[WA] Max reconnect attempts reached')
            connectionStatus = 'error'
          }
        }
      }

      if (connection === 'open') {
        connectionStatus = 'connected'
        qrCode = null
        reconnectAttempts = 0
        connectedPhone = sock.user?.id?.replace(/:.*@/, '@').split('@')[0] || null
        console.log(`[WA] Connected! Phone: ${connectedPhone}`)
      }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        if (!msg.key.fromMe && msg.message) {
          console.log(`[WA] Received from ${msg.key.remoteJid}`)
        }
      }
    })
  } catch (error) {
    console.error('[WA] Connect error:', error.message)
    connectionStatus = 'error'
    setTimeout(() => connectWhatsApp(), 10000)
  }
}

async function sendMessage(phone, message) {
  if (!sock) throw new Error('WhatsApp nao conectado')
  const jid = normalizePhone(phone) + '@s.whatsapp.net'
  console.log(`[WA] Sending to ${jid}`)
  const result = await sock.sendMessage(jid, { text: message })
  console.log(`[WA] Sent OK id=${result.key.id}`)
  return result
}

app.get('/api/status', (req, res) => {
  res.json({ status: connectionStatus, phone: connectedPhone, hasQr: !!qrCode })
})

app.get('/api/qr', (req, res) => {
  res.json({ qr: qrCode, status: connectionStatus })
})

app.get('/api/debug', (req, res) => {
  res.json({
    status: connectionStatus,
    phone: connectedPhone,
    hasSock: !!sock,
    hasSendMessage: sock ? typeof sock.sendMessage === 'function' : false,
    reconnectAttempts,
    authExists: fs.existsSync(AUTH_DIR),
  })
})

app.post('/api/connect', async (req, res) => {
  try {
    reconnectAttempts = 0
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

  console.log(`[WA] Send request: phone=${phone} sock=${!!sock} status=${connectionStatus}`)

  if (!sock) {
    return res.status(400).json({ success: false, error: 'WhatsApp nao conectado. Escaneie o QR code.' })
  }

  try {
    const result = await sendMessage(phone, message)
    messageQueue.push({ to: phone, message: message.substring(0, 100), sentAt: new Date().toISOString(), messageId: result.key.id })
    res.json({ success: true, messageId: result.key.id })
  } catch (error) {
    console.error('[WA] Send error:', error.message)
    if (error.message.includes('Connection') || error.message.includes('not open')) {
      connectionStatus = 'disconnected'
      setTimeout(() => connectWhatsApp(), 5000)
    }
    res.status(500).json({ success: false, error: error.message })
  }
})

app.post('/api/send-batch', async (req, res) => {
  const { messages } = req.body
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ success: false, error: 'messages array required' })
  }
  if (!sock) {
    return res.status(400).json({ success: false, error: 'WhatsApp nao conectado' })
  }

  const results = []
  for (const { phone, message } of messages) {
    try {
      const result = await sendMessage(phone, message)
      results.push({ phone, success: true, messageId: result.key.id })
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000))
    } catch (error) {
      results.push({ phone, success: false, error: error.message })
    }
  }
  res.json({ success: true, results })
})

app.post('/api/disconnect', (req, res) => {
  try {
    if (sock) { try { sock.end(undefined, true) } catch {} }
    sock = null
    qrCode = null
    connectionStatus = 'disconnected'
    connectedPhone = null
    reconnectAttempts = 0
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
app.listen(PORT, () => console.log(`[VagaZaps WA] Running on port ${PORT}`))
