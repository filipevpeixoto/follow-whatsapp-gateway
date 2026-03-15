export function normalizeBrazilPhoneNumber(value) {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (!digits) return null

  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return digits
  }

  if (digits.length === 10 || digits.length === 11) {
    return `55${digits}`
  }

  return null
}

function addBrazilNinthDigitVariants(value, candidates) {
  if (!value?.startsWith('55')) return

  if (value.length === 13 && value[4] === '9') {
    candidates.add(`${value.slice(0, 4)}${value.slice(5)}`)
  }

  if (value.length === 12) {
    candidates.add(`${value.slice(0, 4)}9${value.slice(4)}`)
  }
}

export function buildWhatsAppLookupCandidates(value) {
  const normalized = normalizeBrazilPhoneNumber(value)
  if (!normalized) return []

  const candidates = new Set([normalized])
  addBrazilNinthDigitVariants(normalized, candidates)

  return [...candidates]
}

export function buildWhatsAppLookupJids(value) {
  return buildWhatsAppLookupCandidates(value).map((phone) => `${phone}@s.whatsapp.net`)
}

export async function resolveTargetJid(socket, phone) {
  const candidateJids = buildWhatsAppLookupJids(phone)
  if (candidateJids.length === 0) {
    throw new Error('Numero de telefone invalido.')
  }

  const results = await socket.onWhatsApp(...candidateJids)
  const match = results.find((result) => result?.exists && result?.jid)
  if (!match?.jid) {
    throw new Error('Numero nao encontrado no WhatsApp.')
  }

  return match.jid
}
