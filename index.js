import express from 'express'
import cors from 'cors'
import QRCode from 'qrcode'
import { existsSync, mkdirSync, rmSync } from 'fs'
import path from 'path'
import pino from 'pino'
import { resolveTargetJid } from './phone.js'
import { useDbAuthState, clearDbAuthState } from './db-auth-state.js'

const baileys = await import('@whiskeysockets/baileys')
const makeWASocket = baileys.default
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = baileys

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3002
const API_SECRET = process.env.GATEWAY_SECRET || ''
const AUTH_DIR = process.env.AUTH_DIR || './.wwebjs_auth'
const MANUAL_DISCONNECT_GRACE_MS = Number(process.env.MANUAL_DISCONNECT_GRACE_MS || 1500)
const BACKEND_URL = process.env.BACKEND_URL || ''

const logger = pino({ level: 'warn' })

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
// Key: pastorId (string), Value: { socket, qr, qrDataUrl, status, phone, error }

const sessions = new Map()

function getSession(pastorId) {
  return sessions.get(pastorId) || null
}

function getSessionDir(pastorId) {
  return path.join(AUTH_DIR, `session-${pastorId}`)
}

async function clearPersistedSession(pastorId) {
  if (BACKEND_URL) {
    try {
      await clearDbAuthState(pastorId, BACKEND_URL, API_SECRET)
      console.log(`[${pastorId}] Cleared DB auth state`)
      return true
    } catch (err) {
      console.error(`[${pastorId}] Failed to clear DB auth state:`, err.message)
      return false
    }
  }
  const sessionDir = getSessionDir(pastorId)
  if (!existsSync(sessionDir)) return false

  rmSync(sessionDir, { recursive: true, force: true })
  return true
}

async function destroySession(pastorId, { clearAuth = false } = {}) {
  const session = getSession(pastorId)

  if (session) {
    session.manualDisconnect = true
    session.status = 'disconnected'
    session.qr = null
    session.qrDataUrl = null
    session.phone = null
    session.error = clearAuth
      ? 'Sessão desconectada. Escaneie o QR code novamente.'
      : 'Sessão desconectada.'

    try {
      await session.socket?.logout()
    } catch {
      /* ignore */
    }

    try {
      session.socket?.end()
    } catch {
      /* ignore */
    }
  }

  sessions.delete(pastorId)

  if (!clearAuth) {
    return { hadSession: Boolean(session), clearedAuth: false }
  }

  // Wait a moment so Baileys finishes the logout flow before we remove auth files.
  await sleep(MANUAL_DISCONNECT_GRACE_MS)
  const clearedAuth = await clearPersistedSession(pastorId)
  return { hadSession: Boolean(session), clearedAuth }
}

async function createSession(pastorId) {
  if (sessions.has(pastorId)) {
    const existing = sessions.get(pastorId)
    if (['ready', 'qr', 'initializing'].includes(existing.status)) return existing
    try { existing.socket?.end() } catch { /* ignore */ }
    sessions.delete(pastorId)
  }

  const session = {
    socket: null,
    qr: null,
    qrDataUrl: null,
    status: 'initializing',
    phone: null,
    error: null,
    manualDisconnect: false,
  }
  sessions.set(pastorId, session)

  try {
    let state, saveCreds
    if (BACKEND_URL) {
      console.log(`[${pastorId}] Using DB auth state via ${BACKEND_URL}`)
      ;({ state, saveCreds } = await useDbAuthState(pastorId, BACKEND_URL, API_SECRET))
    } else {
      const sessionDir = getSessionDir(pastorId)
      if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true })
      ;({ state, saveCreds } = await useMultiFileAuthState(sessionDir))
    }
    const { version } = await fetchLatestBaileysVersion()

    const socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      browser: ['Follow', 'Chrome', '125.0.0'],
      generateHighQualityLinkPreview: false,
    })

    session.socket = socket

    socket.ev.on('creds.update', saveCreds)

    socket.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
      // handle both 'notify' (real-time) and 'append' (catch-up after reconnect)
      if (type !== 'notify' && type !== 'append') return
      for (const msg of msgs) {
        if (msg.key.fromMe) continue
        const remoteJid = msg.key.remoteJid || ''
        if (remoteJid.endsWith('@g.us')) continue // skip group messages
        const from = remoteJid.replace('@s.whatsapp.net', '')
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
        if (!text || !from) continue
        console.log(`[${pastorId}] Incoming message from ${from}: ${text}`)
        if (BACKEND_URL) {
          try {
            await fetch(`${BACKEND_URL}/whatsapp/system-incoming`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(API_SECRET ? { 'x-gateway-secret': API_SECRET } : {}),
              },
              body: JSON.stringify({ pastorId, from, text }),
            })
          } catch (err) {
            console.error(`[${pastorId}] Failed to forward incoming message:`, err.message)
          }
        }
      }
    })

    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr: qrCode } = update

      if (qrCode) {
        session.qr = qrCode
        session.status = 'qr'
        session.error = null
        try {
          session.qrDataUrl = await QRCode.toDataURL(qrCode, { width: 300, margin: 2 })
        } catch {
          session.qrDataUrl = null
        }
        console.log(`[${pastorId}] QR code generated`)
      }

      if (connection === 'open') {
        session.status = 'ready'
        session.qr = null
        session.qrDataUrl = null
        session.error = null
        session.phone = socket.user?.id?.split(':')[0] || socket.user?.id?.split('@')[0] || null
        console.log(`[${pastorId}] Connected as ${session.phone}`)
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const isCurrentSession = sessions.get(pastorId) === session
        // 401 = loggedOut. But if we never connected (phone is null), it just means
        // the QR codes expired — we should retry, not give up.
        const wasEverConnected = Boolean(session.phone)
        const shouldReconnect = !session.manualDisconnect &&
          (statusCode !== DisconnectReason.loggedOut || !wasEverConnected)

        console.log(`[${pastorId}] Connection closed. Status: ${statusCode}. Reconnect: ${shouldReconnect}. WasConnected: ${wasEverConnected}`)

        if (!isCurrentSession) {
          return
        }

        if (session.manualDisconnect) {
          console.log(`[${pastorId}] Manual disconnect completed`)
          return
        }

        if (shouldReconnect) {
          // Reconnect — remove old session object and recreate
          sessions.delete(pastorId)
          // Only clear persisted auth if QR expired (401 without ever connecting).
          // For other errors (515 stream, network, etc.) keep auth files so the
          // handshake can resume without requiring a new QR scan.
          if (statusCode === DisconnectReason.loggedOut && !wasEverConnected) {
            await clearPersistedSession(pastorId)
          }
          setTimeout(() => createSession(pastorId), 2000)
        } else {
          session.status = 'disconnected'
          session.error = 'Desconectado pelo WhatsApp. Escaneie o QR code novamente.'
          session.phone = null
          console.log(`[${pastorId}] Logged out`)
        }
      }
    })
  } catch (err) {
    session.status = 'disconnected'
    session.error = `Erro ao inicializar: ${err.message}`
    console.error(`[${pastorId}] Init error:`, err.message)
  }

  return session
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, sessions: sessions.size })
})

app.post('/session/start', async (req, res) => {
  const { pastorId } = req.body
  if (!pastorId) return res.status(400).json({ error: 'pastorId é obrigatório' })

  const session = await createSession(pastorId)
  res.json({
    status: session.status,
    phone: session.phone,
    qrDataUrl: session.qrDataUrl,
  })
})

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

app.post('/session/disconnect', async (req, res) => {
  const { pastorId } = req.body
  if (!pastorId) return res.status(400).json({ error: 'pastorId é obrigatório' })

  const result = await destroySession(pastorId, { clearAuth: true })
  res.json({ ok: true, ...result })
})

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
    const jid = await resolveTargetJid(session.socket, phone)
    await session.socket.sendMessage(jid, { text: message })
    res.json({ ok: true, jid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/broadcast', async (req, res) => {
  const { pastorId, targets, message } = req.body
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
      const jid = await resolveTargetJid(session.socket, target.phone)
      await session.socket.sendMessage(jid, { text: message })
      sent++
    } catch (err) {
      failed++
      errors.push(`${target.name || target.phone}: ${err.message}`)
    }
    await sleep(1000)
  }

  res.json({ sent, failed, total: targets.length, errors: errors.slice(0, 10) })
})

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`WhatsApp Gateway running on port ${PORT}`)

  // Auto-restore sessions from DB on startup
  if (BACKEND_URL) {
    try {
      const headers = {
        'Content-Type': 'application/json',
        ...(API_SECRET ? { 'x-gateway-secret': API_SECRET } : {}),
      }
      const res = await fetch(`${BACKEND_URL}/whatsapp/auth-state/sessions`, { headers })
      if (res.ok) {
        const { sessionIds } = await res.json()
        for (const sessionId of sessionIds) {
          console.log(`[${sessionId}] Auto-restoring session from DB...`)
          try {
            await createSession(sessionId)
          } catch (err) {
            console.error(`[${sessionId}] Failed to restore:`, err.message)
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch session list for auto-restore:', err.message)
    }
  }
})
