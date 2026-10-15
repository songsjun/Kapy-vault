/**
 * Password slots wrap one secret-wide DEK. Password input derives one KEK, then
 * AES-GCM authentication identifies its slot. No password verifier is persisted.
 * Slot mutations deliberately invalidate the old payload authentication tag;
 * callers must encryptPayload with the new slot list before persisting it.
 */
export const WALLET_ACCESS_FORMAT = 'airgap-wallet-access-v2' as const
export const WALLET_ACCESS_ITERATIONS = 220000
export const MAX_WALLET_SLOTS = 32
/** Includes the 16-byte GCM authentication tag. */
export const MAX_WALLET_CIPHERTEXT_BYTES = 4 * 1024 * 1024
export const MAX_WALLET_PLAINTEXT_BYTES = MAX_WALLET_CIPHERTEXT_BYTES - 16

export interface WalletKeySlot {
  id: string
  iv: string
  key: string
}

export interface WalletSecretEnvelope {
  format: typeof WALLET_ACCESS_FORMAT
  secretId: string
  kdf: { algorithm: 'pbkdf2-sha512'; iterations: 220000; salt: string }
  slots: WalletKeySlot[]
  payload: { iv: string; data: string }
}

export class WalletEnvelopeFormatError extends Error {
  constructor() { super('Invalid wallet envelope'); this.name = 'WalletEnvelopeFormatError' }
}

export class WalletEnvelopeAuthenticationError extends Error {
  constructor() { super('Wallet data is corrupted or authentication failed'); this.name = 'WalletEnvelopeAuthenticationError' }
}

export class WalletPasswordError extends Error {
  constructor() { super('Incorrect wallet password'); this.name = 'WalletPasswordError' }
}

export class DuplicateWalletPasswordError extends Error {
  constructor() { super('Wallet password already exists'); this.name = 'DuplicateWalletPasswordError' }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const MAX_SERIALIZED_CHARS = MAX_WALLET_CIPHERTEXT_BYTES * 2 + 64 * 1024

function webCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== 'function') {
    throw new Error('Web Crypto is required for wallet encryption')
  }
  return globalThis.crypto
}

function randomBytes(length: number): Uint8Array { return webCrypto().getRandomValues(new Uint8Array(length)) }
function toHex(bytes: Uint8Array): string {
  // Keep conversion buffers bounded when encrypting a multi-megabyte payload.
  let result = ''
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    result += Array.from(bytes.subarray(offset, offset + 4096), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  return result
}
function fromHex(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2)
  for (let index = 0; index < result.length; index++) result[index] = parseInt(value.slice(index * 2, index * 2 + 2), 16)
  return result
}

function hex(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length === bytes * 2 && /^[0-9a-f]+$/.test(value)
}

function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function validSecretId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && encoder.encode(value).length <= 256
}

/** Validates object inputs as well as parsed text and snapshots all header fields. */
function validateEnvelope(value: unknown, expectedSecretId?: string): WalletSecretEnvelope {
  if (!record(value, ['format', 'secretId', 'kdf', 'slots', 'payload']) ||
      value.format !== WALLET_ACCESS_FORMAT || !validSecretId(value.secretId) ||
      (expectedSecretId !== undefined && value.secretId !== expectedSecretId) ||
      !record(value.kdf, ['algorithm', 'iterations', 'salt']) || value.kdf.algorithm !== 'pbkdf2-sha512' ||
      value.kdf.iterations !== WALLET_ACCESS_ITERATIONS || !hex(value.kdf.salt, 16) ||
      !Array.isArray(value.slots) || value.slots.length < 1 || value.slots.length > MAX_WALLET_SLOTS ||
      !record(value.payload, ['iv', 'data']) || !hex(value.payload.iv, 12) ||
      typeof value.payload.data !== 'string' || value.payload.data.length < 32 ||
      value.payload.data.length > MAX_WALLET_CIPHERTEXT_BYTES * 2 ||
      value.payload.data.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value.payload.data)) {
    throw new WalletEnvelopeFormatError()
  }
  const ids = new Set<string>()
  const slots = value.slots.map((slot: unknown): WalletKeySlot => {
    if (!record(slot, ['id', 'iv', 'key']) || !hex(slot.id, 16) || !hex(slot.iv, 12) || !hex(slot.key, 48) || ids.has(slot.id)) {
      throw new WalletEnvelopeFormatError()
    }
    ids.add(slot.id)
    return { id: slot.id, iv: slot.iv, key: slot.key }
  })
  return {
    format: WALLET_ACCESS_FORMAT,
    secretId: value.secretId,
    kdf: { algorithm: 'pbkdf2-sha512', iterations: WALLET_ACCESS_ITERATIONS, salt: value.kdf.salt },
    slots,
    payload: { iv: value.payload.iv, data: value.payload.data }
  }
}

export function parseEnvelope(value: string, expectedSecretId: string): WalletSecretEnvelope {
  if (typeof value !== 'string' || value.length > MAX_SERIALIZED_CHARS || !validSecretId(expectedSecretId)) {
    throw new WalletEnvelopeFormatError()
  }
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new WalletEnvelopeFormatError() }
  return validateEnvelope(parsed, expectedSecretId)
}

/** Object keys are sorted recursively; slot array order is authenticated. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return '{' + Object.keys(object).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(object[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function aad(envelope: WalletSecretEnvelope, slot?: WalletKeySlot): Uint8Array {
  const header = { format: envelope.format, secretId: envelope.secretId, kdf: envelope.kdf }
  return encoder.encode(canonicalJson(slot
    ? { ...header, purpose: 'key-slot', slotId: slot.id }
    : { ...header, purpose: 'payload', slots: envelope.slots }))
}

function passwordBytes(password: string): Uint8Array {
  if (typeof password !== 'string' || password.length < 1 || password.length > 1024) {
    throw new TypeError('Wallet passwords must contain 1 to 1024 UTF-8 bytes')
  }
  // TextEncoder replaces lone UTF-16 surrogates. Reject those instead of silently
  // mapping distinct JavaScript strings to an identical password byte sequence.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(password)) {
    throw new TypeError('Wallet passwords must contain valid Unicode text')
  }
  const bytes = encoder.encode(password)
  if (bytes.length > 1024) { bytes.fill(0); throw new TypeError('Wallet passwords must contain 1 to 1024 UTF-8 bytes') }
  return bytes
}

async function deriveKek(envelope: WalletSecretEnvelope, password: string): Promise<CryptoKey> {
  const bytes = passwordBytes(password)
  const salt = fromHex(envelope.kdf.salt)
  try {
    const crypto = webCrypto()
    const base = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey'])
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-512', iterations: WALLET_ACCESS_ITERATIONS, salt },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    )
  } finally { bytes.fill(0); salt.fill(0) }
}

async function importDek(key: Uint8Array): Promise<CryptoKey> {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new TypeError('A 32-byte wallet data key is required')
  const copy = new Uint8Array(key)
  try { return await webCrypto().subtle.importKey('raw', copy, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']) }
  finally { copy.fill(0) }
}

function isAuthenticationFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'OperationError'
}

async function unwrap(envelope: WalletSecretEnvelope, slot: WalletKeySlot, kek: CryptoKey): Promise<Uint8Array | undefined> {
  const iv = fromHex(slot.iv)
  const wrapped = fromHex(slot.key)
  const additionalData = aad(envelope, slot)
  try {
    return new Uint8Array(await webCrypto().subtle.decrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, kek, wrapped))
  } catch (error) {
    // Only an authentication mismatch means this password did not match a slot.
    // Unsupported algorithms, missing Web Crypto and programming errors propagate.
    if (isAuthenticationFailure(error)) return undefined
    throw error
  } finally { iv.fill(0); wrapped.fill(0); additionalData.fill(0) }
}

async function wrap(envelope: WalletSecretEnvelope, id: string, key: Uint8Array, kek: CryptoKey): Promise<WalletKeySlot> {
  const iv = randomBytes(12)
  const slot: WalletKeySlot = { id, iv: toHex(iv), key: '' }
  const additionalData = aad(envelope, slot)
  const copy = new Uint8Array(key)
  try {
    slot.key = toHex(new Uint8Array(await webCrypto().subtle.encrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, kek, copy)))
    return slot
  } finally { iv.fill(0); additionalData.fill(0); copy.fill(0) }
}

async function decryptBytes(envelope: WalletSecretEnvelope, key: CryptoKey): Promise<Uint8Array> {
  const iv = fromHex(envelope.payload.iv)
  const ciphertext = fromHex(envelope.payload.data)
  const additionalData = aad(envelope)
  try {
    return new Uint8Array(await webCrypto().subtle.decrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, key, ciphertext))
  } catch (error) {
    if (isAuthenticationFailure(error)) throw new WalletEnvelopeAuthenticationError()
    throw error
  } finally { iv.fill(0); ciphertext.fill(0); additionalData.fill(0) }
}

async function authenticateKey(envelope: WalletSecretEnvelope, key: Uint8Array): Promise<void> {
  const plaintext = await decryptBytes(envelope, await importDek(key))
  plaintext.fill(0)
}

async function rejectDuplicate(envelope: WalletSecretEnvelope, kek: CryptoKey, allowedId?: string): Promise<void> {
  for (const slot of envelope.slots) {
    const unwrapped = await unwrap(envelope, slot, kek)
    if (unwrapped) {
      unwrapped.fill(0)
      if (slot.id !== allowedId) throw new DuplicateWalletPasswordError()
    }
  }
}

export async function createEnvelope(secretId: string, profileId: string, password: string, plaintext: string): Promise<{ envelope: WalletSecretEnvelope; key: Uint8Array }> {
  if (!validSecretId(secretId) || !hex(profileId, 16)) throw new WalletEnvelopeFormatError()
  const salt = randomBytes(16)
  const key = randomBytes(32)
  const envelope: WalletSecretEnvelope = {
    format: WALLET_ACCESS_FORMAT, secretId,
    kdf: { algorithm: 'pbkdf2-sha512', iterations: WALLET_ACCESS_ITERATIONS, salt: toHex(salt) },
    // Internal structural placeholder; createEnvelope never exposes it unsealed.
    slots: [], payload: { iv: '00'.repeat(12), data: '00'.repeat(16) }
  }
  salt.fill(0)
  try {
    envelope.slots.push(await wrap(envelope, profileId, key, await deriveKek(envelope, password)))
    return { envelope: await encryptPayload(envelope, key, plaintext), key }
  } catch (error) { key.fill(0); throw error }
}

export async function openEnvelope(value: WalletSecretEnvelope, password: string): Promise<{ profileId: string; key: Uint8Array; plaintext: string }> {
  const envelope = validateEnvelope(value)
  const kek = await deriveKek(envelope, password)
  for (const slot of envelope.slots) {
    const key = await unwrap(envelope, slot, kek)
    if (!key) continue
    try { return { profileId: slot.id, key, plaintext: await decryptPayload(envelope, key) } }
    catch (error) { key.fill(0); throw error }
  }
  throw new WalletPasswordError()
}

export async function addKeySlot(value: WalletSecretEnvelope, key: Uint8Array, profileId: string, password: string): Promise<WalletSecretEnvelope> {
  const envelope = validateEnvelope(value)
  if (!hex(profileId, 16) || envelope.slots.some((slot) => slot.id === profileId) || envelope.slots.length >= MAX_WALLET_SLOTS) {
    throw new WalletEnvelopeFormatError()
  }
  await authenticateKey(envelope, key)
  const kek = await deriveKek(envelope, password)
  await rejectDuplicate(envelope, kek)
  envelope.slots.push(await wrap(envelope, profileId, key, kek))
  return envelope
}

export function removeKeySlot(value: WalletSecretEnvelope, profileId: string): WalletSecretEnvelope {
  const envelope = validateEnvelope(value)
  if (!hex(profileId, 16) || envelope.slots.length <= 1 || !envelope.slots.some((slot) => slot.id === profileId)) {
    throw new WalletEnvelopeFormatError()
  }
  envelope.slots = envelope.slots.filter((slot) => slot.id !== profileId)
  return envelope
}

export async function replaceKeySlot(value: WalletSecretEnvelope, key: Uint8Array, profileId: string, password: string): Promise<WalletSecretEnvelope> {
  const envelope = validateEnvelope(value)
  const index = envelope.slots.findIndex((slot) => slot.id === profileId)
  if (!hex(profileId, 16) || index < 0) throw new WalletEnvelopeFormatError()
  await authenticateKey(envelope, key)
  const kek = await deriveKek(envelope, password)
  await rejectDuplicate(envelope, kek, profileId)
  envelope.slots[index] = await wrap(envelope, profileId, key, kek)
  return envelope
}

export async function encryptPayload(value: WalletSecretEnvelope, key: Uint8Array, plaintext: string): Promise<WalletSecretEnvelope> {
  // Slot changes carry a structurally valid but invalidated old payload. Do not
  // hide malformed input fields by overwriting them before validation.
  const envelope = validateEnvelope(value)
  if (typeof plaintext !== 'string' || plaintext.length > MAX_WALLET_PLAINTEXT_BYTES) {
    throw new TypeError('Wallet plaintext exceeds its size limit')
  }
  const bytes = encoder.encode(plaintext)
  const iv = new Uint8Array(12)
  const additionalData = aad(envelope)
  try {
    if (bytes.length > MAX_WALLET_PLAINTEXT_BYTES) throw new TypeError('Wallet plaintext exceeds its size limit')
    webCrypto().getRandomValues(iv)
    const cryptoKey = await importDek(key)
    envelope.payload = {
      iv: toHex(iv),
      data: toHex(new Uint8Array(await webCrypto().subtle.encrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, cryptoKey, bytes)))
    }
    return envelope
  } finally { bytes.fill(0); iv.fill(0); additionalData.fill(0) }
}

export async function decryptPayload(value: WalletSecretEnvelope, key: Uint8Array): Promise<string> {
  const envelope = validateEnvelope(value)
  const plaintext = await decryptBytes(envelope, await importDek(key))
  try { return decoder.decode(plaintext) }
  catch { throw new WalletEnvelopeAuthenticationError() }
  finally { plaintext.fill(0) }
}
