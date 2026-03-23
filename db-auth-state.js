/**
 * Baileys auth state backed by the Follow backend PostgreSQL database.
 * Replaces useMultiFileAuthState — credentials survive gateway restarts.
 */
const baileys = await import('@whiskeysockets/baileys')
const { proto } = baileys
const { initAuthCreds } = baileys

export async function useDbAuthState(sessionId, backendUrl, gatewaySecret) {
  const headers = {
    'Content-Type': 'application/json',
    ...(gatewaySecret ? { 'x-gateway-secret': gatewaySecret } : {}),
  }

  async function readAll() {
    const res = await fetch(`${backendUrl}/whatsapp/auth-state/${sessionId}`, { headers })
    if (!res.ok) return {}
    return await res.json()
  }

  async function writeKey(key, data) {
    await fetch(`${backendUrl}/whatsapp/auth-state/${sessionId}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key, data }),
    })
  }

  async function deleteKeys(keys) {
    await fetch(`${backendUrl}/whatsapp/auth-state/${sessionId}/delete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ keys }),
    })
  }

  // Load existing state from DB
  const stored = await readAll()

  // Restore or initialize creds
  const creds = stored['creds.json']
    ? JSON.parse(typeof stored['creds.json'] === 'string' ? stored['creds.json'] : JSON.stringify(stored['creds.json']))
    : initAuthCreds()

  // Fix Buffer serialization from JSON
  function fixBuffers(obj) {
    if (!obj || typeof obj !== 'object') return obj
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
      return Buffer.from(obj.data)
    }
    for (const key of Object.keys(obj)) {
      obj[key] = fixBuffers(obj[key])
    }
    return obj
  }

  return {
    state: {
      creds: fixBuffers(creds),
      keys: {
        get: async (type, ids) => {
          const data = {}
          for (const id of ids) {
            const key = `${type}-${id}`
            if (stored[key]) {
              let value = stored[key]
              if (typeof value === 'string') {
                try { value = JSON.parse(value) } catch { /* keep as-is */ }
              }
              if (type === 'app-state-sync-key') {
                data[id] = proto.Message.AppStateSyncKeyData.fromObject(fixBuffers(value))
              } else {
                data[id] = fixBuffers(value)
              }
            }
          }
          return data
        },
        set: async (data) => {
          const promises = []
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const key = `${category}-${id}`
              const value = data[category][id]
              if (value) {
                stored[key] = value
                promises.push(writeKey(key, value))
              } else {
                delete stored[key]
                promises.push(deleteKeys([key]))
              }
            }
          }
          await Promise.all(promises)
        },
      },
    },
    saveCreds: async () => {
      await writeKey('creds.json', creds)
    },
  }
}

export async function clearDbAuthState(sessionId, backendUrl, gatewaySecret) {
  const headers = {
    'Content-Type': 'application/json',
    ...(gatewaySecret ? { 'x-gateway-secret': gatewaySecret } : {}),
  }
  await fetch(`${backendUrl}/whatsapp/auth-state/${sessionId}/delete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  })
}
