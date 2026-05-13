import { readFileSync, writeFileSync } from 'fs'

const defaultsPath = 'node_modules/@whiskeysockets/baileys/lib/Defaults/index.js'
const source = readFileSync(defaultsPath, 'utf8')
const patched = source.replace(
  'export const INITIAL_PREKEY_COUNT = 812;',
  'export const INITIAL_PREKEY_COUNT = 50;',
)

if (patched === source) {
  throw new Error('Baileys INITIAL_PREKEY_COUNT patch did not match')
}

writeFileSync(defaultsPath, patched)
console.log('Patched Baileys INITIAL_PREKEY_COUNT to 50')
