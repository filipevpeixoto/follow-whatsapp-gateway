import express from 'express'
import cors from 'cors'
import pkg from 'whatsapp-web.js'
import QRCode from 'qrcode'

const { Client, LocalAuth } = pkg

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3002
const API_SECRET = process.env.GATEWAY_SECRET || ''

// ── Auth middleware ──────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  if (!API_SECRET) return next()
  const token = req.headers['x-gateway-secret']
  if (token !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

app.use(authMiddleware)

// ── Session store ───────────────────────────────────────────────────────────
// Key: pastorId (string), Value: { client, qr, status, phone }

const sessions = new Map()

function getSession(pastorId) {
  return sessions.get(pastorId) || null
}

function createSession(pastorId) {
  if (sessions.has(pastorId)) {
    const existing = sessions.get(pastorId)
    // Don't destroy active sessions
    if (['ready', 'qr', 'initializing'].includes(existing.status)) return existing
    // Only recreate if disconnected or errored
    try { existing.client.destroy() } catch { /* ignore */ }
    sessions.delete(pastorId)
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: pastorId }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
      ],
    },
  })

  const session = {
    client,
    qr: null,
    qrDataUrl: null,
    status: 'initializing', // initializing | qr | ready | disconnected
    phone: null,
    error: null,
  }

  client.on('qr', async (qr) => {
    session.qr = qr
    session.status = 'qr'
    session.error = null
    try {
      session.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 })
    } catch {
      session.qrDataUrl = null
    }
    console.log(`[${pastorId}] QR code generated`)
  })

  client.on('ready', () => {
    session.status = 'ready'
    session.qr = null
    session.qrDataUrl = null
    session.error = null
    const info = client.info
    session.phone = info?.wid?.user || null
    console.log(`[${pastorId}] Connected as ${session.phone}`)
  })

  client.on('authenticated', () => {
    console.log(`[${pastorId}] Authenticated`)
  })

  client.on('auth_failure', (msg) => {
    session.status = 'disconnected'
    session.error = `Falha na autenticação: ${msg}`
    console.error(`[${pastorId}] Auth failure:`, msg)
  })

  client.on('disconnected', (reason) => {
    session.status = 'disconnected'
    session.error = `Desconectado: ${reason}`
    session.phone = null
    console.log(`[${pastorId}] Disconnected:`, reason)
  })

  client.initialize().catch((err) => {
    session.status = 'disconnected'
    session.error = `Erro ao inicializar: ${err.message}`
    console.error(`[${pastorId}] Init error:`, err)
  })

  sessions.set(pastorId, session)
  return session
}

// ── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, sessions: sessions.size })
})

// Start a session and get QR code
app.post('/session/start', (req, res) => {
  const { pastorId } = req.body
  if (!pastorId) return res.status(400).json({ error: 'pastorId é obrigatório' })

  const session = createSession(pastorId)
  res.json({
    status: session.status,
    phone: session.phone,
    qrDataUrl: session.qrDataUrl,
  })
})

// Get session status (polling)
app.get('/session/status/:pastorId', (req, res) => {
  const session = getSession(req.params.pastorId)
  if (!session) {
    return res.json({ status: 'none', phone: null, qrDataUrl: null })
  }
  res.json({
    status: session.status,
    phone: session.phone,
    qrDataUrl: session.qrDataUrl,
    error: session.error,
  })
})

// Disconnect session
app.post('/session/disconnect', async (req, res) => {
  const { pastorId } = req.body
  if (!pastorId) return res.status(400).json({ error: 'pastorId é obrigatório' })

  const session = getSession(pastorId)
  if (!session) return res.json({ ok: true, message: 'Sessão não encontrada' })

  try {
    await session.client.destroy()
  } catch { /* ignore */ }
  sessions.delete(pastorId)

  res.json({ ok: true })
})

// Send a single message
app.post('/send', async (req, res) => {
  const { pastorId, phone, message } = req.body
  if (!pastorId || !phone || !message) {
    return res.status(400).json({ error: 'pastorId, phone e message são obrigatórios' })
  }

  const session = getSession(pastorId)
  if (!session || session.status !== 'ready') {
    return res.status(400).json({ error: 'WhatsApp não conectado. Escaneie o QR code primeiro.' })
  }

  try {
    const chatId = formatChatId(phone)
    await session.client.sendMessage(chatId, message)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Broadcast to multiple phones
app.post('/broadcast', async (req, res) => {
  const { pastorId, targets, message } = req.body
  // targets: [{ phone, name }]
  if (!pastorId || !targets || !message) {
    return res.status(400).json({ error: 'pastorId, targets e message são obrigatórios' })
  }

  const session = getSession(pastorId)
  if (!session || session.status !== 'ready') {
    return res.status(400).json({ error: 'WhatsApp não conectado. Escaneie o QR code primeiro.' })
  }

  let sent = 0
  let failed = 0
  const errors = []

  for (const target of targets) {
    try {
      const chatId = formatChatId(target.phone)
      await session.client.sendMessage(chatId, message)
      sent++
    } catch (err) {
      failed++
      errors.push(`${target.name || target.phone}: ${err.message}`)
    }
    // Small delay to avoid rate limiting
    await sleep(1000)
  }

  res.json({ sent, failed, total: targets.length, errors: errors.slice(0, 10) })
})

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatChatId(phone) {
  // Remove non-digits, ensure it ends with @c.us
  const digits = phone.replace(/\D/g, '')
  return `${digits}@c.us`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`WhatsApp Gateway running on port ${PORT}`)
})
