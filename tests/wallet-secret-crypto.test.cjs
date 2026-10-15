const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const test = require('node:test')
const { webcrypto, pbkdf2Sync, createDecipheriv, createCipheriv, randomBytes } = require('node:crypto')
const ts = require('typescript')

// Exercise the actual isolated TypeScript module with the standard Web Crypto
// implementation. Node 18 exposes the same provider through node:crypto.
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
const filename = path.resolve(__dirname, '../src/app/services/wallet-access/wallet-secret-crypto.ts')
const loaded = new Module(filename, module)
loaded.filename = filename
loaded.paths = module.paths
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, filename)
const crypto = loaded.exports
const {
  createEnvelope, openEnvelope, addKeySlot, removeKeySlot, replaceKeySlot,
  encryptPayload, decryptPayload, parseEnvelope, WalletEnvelopeFormatError,
  WalletEnvelopeAuthenticationError, WalletPasswordError, DuplicateWalletPasswordError
} = crypto
const SECRET = 'public-test-secret'
const ID_A = '01'.repeat(16)
const ID_B = '02'.repeat(16)
const ID_C = '03'.repeat(16)
const PLAINTEXT = JSON.stringify({ format: 'public-test-data', entropy: '00'.repeat(16), label: '公开测试' })
const clone = (value) => JSON.parse(JSON.stringify(value))
const flip = (hex) => (hex.startsWith('0') ? '1' : '0') + hex.slice(1)

let fixture
test.before(async () => { fixture = await createEnvelope(SECRET, ID_A, 'Public password A', PLAINTEXT) })
test.after(() => fixture?.key.fill(0))

test('format v2 uses fixed strong KDF, shared salt and authenticated ciphertext without a fast verifier', async () => {
  const { envelope, key } = fixture
  assert.equal(envelope.format, 'airgap-wallet-access-v2')
  assert.deepEqual(Object.keys(envelope).sort(), ['format', 'kdf', 'payload', 'secretId', 'slots'])
  assert.equal(envelope.kdf.algorithm, 'pbkdf2-sha512')
  assert.equal(envelope.kdf.iterations, 220000)
  assert.match(envelope.kdf.salt, /^[0-9a-f]{32}$/)
  assert.equal(envelope.slots[0].key.length, 96)
  assert.equal(key.length, 32)
  assert.equal(JSON.stringify(envelope).includes('Public password A'), false)
  assert.equal(JSON.stringify(envelope).includes('公开测试'), false)
  assert.deepEqual(parseEnvelope(JSON.stringify(envelope), SECRET), envelope)
  const opened = await openEnvelope(envelope, 'Public password A')
  assert.equal(opened.profileId, ID_A)
  assert.equal(opened.plaintext, PLAINTEXT)
  assert.deepEqual(opened.key, key)
  opened.key.fill(0)
})

test('independent Node PBKDF2 and AES-GCM interoperate with the published envelope and AAD format', async () => {
  const envelope = fixture.envelope
  // Deliberately reconstruct canonical field ordering here without importing the
  // module's AAD or JSON helpers. Node's non-WebCrypto API is an independent path.
  const kdf = { algorithm: 'pbkdf2-sha512', iterations: 220000, salt: envelope.kdf.salt }
  const slot = envelope.slots[0]
  const wrapperAad = Buffer.from(JSON.stringify({
    format: 'airgap-wallet-access-v2', kdf, purpose: 'key-slot', secretId: SECRET, slotId: ID_A
  }), 'utf8')
  const payloadAad = Buffer.from(JSON.stringify({
    format: 'airgap-wallet-access-v2', kdf, purpose: 'payload', secretId: SECRET,
    slots: envelope.slots.map(({ id, iv, key }) => ({ id, iv, key }))
  }), 'utf8')
  const kek = pbkdf2Sync(Buffer.from('Public password A', 'utf8'), Buffer.from(kdf.salt, 'hex'), 220000, 32, 'sha512')
  let dek, cleartext
  try {
    const wrapped = Buffer.from(slot.key, 'hex')
    const unwrap = createDecipheriv('aes-256-gcm', kek, Buffer.from(slot.iv, 'hex'), { authTagLength: 16 })
    unwrap.setAAD(wrapperAad)
    unwrap.setAuthTag(wrapped.subarray(-16))
    dek = Buffer.concat([unwrap.update(wrapped.subarray(0, -16)), unwrap.final()])
    assert.deepEqual(new Uint8Array(dek), fixture.key)
    const encryptedPayload = Buffer.from(envelope.payload.data, 'hex')
    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(envelope.payload.iv, 'hex'), { authTagLength: 16 })
    decipher.setAAD(payloadAad)
    decipher.setAuthTag(encryptedPayload.subarray(-16))
    cleartext = Buffer.concat([decipher.update(encryptedPayload.subarray(0, -16)), decipher.final()])
    assert.equal(cleartext.toString('utf8'), PLAINTEXT)

    // Also encrypt externally and require the application to authenticate it.
    const externalIv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', dek, externalIv, { authTagLength: 16 })
    cipher.setAAD(payloadAad)
    const externalData = Buffer.concat([cipher.update('Public Node interoperability fixture', 'utf8'), cipher.final(), cipher.getAuthTag()])
    const externalEnvelope = { ...clone(envelope), payload: { iv: externalIv.toString('hex'), data: externalData.toString('hex') } }
    assert.equal(await decryptPayload(externalEnvelope, fixture.key), 'Public Node interoperability fixture')
  } finally {
    kek.fill(0)
    dek?.fill(0)
    cleartext?.fill(0)
  }
})

test('one password attempt performs exactly one production PBKDF2 derivation across multiple slots', async (context) => {
  let envelope = await addKeySlot(fixture.envelope, fixture.key, ID_B, 'Public password B')
  envelope = await encryptPayload(envelope, fixture.key, PLAINTEXT)
  const original = globalThis.crypto.subtle.deriveKey.bind(globalThis.crypto.subtle)
  const calls = []
  context.mock.method(globalThis.crypto.subtle, 'deriveKey', async (...args) => {
    calls.push(args)
    return original(...args)
  })
  const opened = await openEnvelope(envelope, 'Public password B')
  assert.equal(opened.profileId, ID_B)
  assert.deepEqual(opened.key, fixture.key)
  opened.key.fill(0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0].iterations, 220000)
  assert.equal(calls[0][0].hash, 'SHA-512')
  assert.equal(calls[0][3], false)
  calls.length = 0
  await assert.rejects(openEnvelope(envelope, 'Unknown password'), (error) => error instanceof WalletPasswordError && error.message === 'Incorrect wallet password')
  assert.equal(calls.length, 1)
})

test('adding slots shares one DEK and requires resealing the authenticated complete slot list', async () => {
  const original = clone(fixture.envelope)
  let changed = await addKeySlot(original, fixture.key, ID_B, 'Public password B')
  assert.deepEqual(original, fixture.envelope)
  assert.equal(changed.kdf.salt, original.kdf.salt)
  await assert.rejects(decryptPayload(changed, fixture.key), WalletEnvelopeAuthenticationError)
  changed = await encryptPayload(changed, fixture.key, PLAINTEXT)
  for (const password of ['Public password A', 'Public password B']) {
    const opened = await openEnvelope(changed, password)
    assert.deepEqual(opened.key, fixture.key)
    assert.equal(opened.plaintext, PLAINTEXT)
    opened.key.fill(0)
  }
  await assert.rejects(addKeySlot(changed, fixture.key, ID_C, 'Public password B'), DuplicateWalletPasswordError)
  await assert.rejects(addKeySlot(changed, new Uint8Array(32), ID_C, 'Third password'), WalletEnvelopeAuthenticationError)
  await assert.rejects(addKeySlot(changed, fixture.key, ID_B, 'Third password'), WalletEnvelopeFormatError)
})

test('removing and replacing slots revokes old passwords and rejects duplicate passwords on other profiles', async () => {
  let envelope = await encryptPayload(await addKeySlot(fixture.envelope, fixture.key, ID_B, 'Public password B'), fixture.key, PLAINTEXT)
  await assert.rejects(replaceKeySlot(envelope, fixture.key, ID_A, 'Public password B'), DuplicateWalletPasswordError)
  const previousIv = envelope.slots[0].iv
  envelope = await replaceKeySlot(envelope, fixture.key, ID_A, 'Public replacement password')
  assert.notEqual(envelope.slots[0].iv, previousIv)
  await assert.rejects(decryptPayload(envelope, fixture.key), WalletEnvelopeAuthenticationError)
  envelope = await encryptPayload(envelope, fixture.key, PLAINTEXT)
  await assert.rejects(openEnvelope(envelope, 'Public password A'), WalletPasswordError)
  const replaced = await openEnvelope(envelope, 'Public replacement password')
  assert.equal(replaced.profileId, ID_A)
  replaced.key.fill(0)
  // Re-registering the same profile's existing password is allowed, with a new IV.
  envelope = await encryptPayload(await replaceKeySlot(envelope, fixture.key, ID_A, 'Public replacement password'), fixture.key, PLAINTEXT)
  envelope = removeKeySlot(envelope, ID_B)
  await assert.rejects(decryptPayload(envelope, fixture.key), WalletEnvelopeAuthenticationError)
  envelope = await encryptPayload(envelope, fixture.key, PLAINTEXT)
  await assert.rejects(openEnvelope(envelope, 'Public password B'), WalletPasswordError)
  assert.throws(() => removeKeySlot(envelope, ID_A), WalletEnvelopeFormatError)
  assert.throws(() => removeKeySlot(envelope, ID_C), WalletEnvelopeFormatError)
  await assert.rejects(replaceKeySlot(envelope, fixture.key, ID_C, 'Unknown profile'), WalletEnvelopeFormatError)
})

test('payload tag, nonce and ordered complete slot metadata are authenticated', async () => {
  const envelope = await encryptPayload(await addKeySlot(fixture.envelope, fixture.key, ID_B, 'Public password B'), fixture.key, PLAINTEXT)
  const mutations = [
    (value) => { value.payload.data = flip(value.payload.data) },
    (value) => { value.payload.iv = flip(value.payload.iv) },
    (value) => { value.slots.reverse() },
    (value) => { value.slots.pop() },
    (value) => { value.slots[1].id = ID_C },
    (value) => { value.slots[1].iv = flip(value.slots[1].iv) },
    (value) => { value.slots[1].key = flip(value.slots[1].key) }
  ]
  for (const mutate of mutations) {
    const damaged = clone(envelope)
    mutate(damaged)
    await assert.rejects(openEnvelope(damaged, 'Public password A'), WalletEnvelopeAuthenticationError)
  }
})

test('wrapper AAD binds the secret ID, KDF salt and slot ID; damaged headers cannot unlock', async () => {
  for (const mutate of [
    (value) => { value.secretId = 'another-public-secret' },
    (value) => { value.kdf.salt = flip(value.kdf.salt) },
    (value) => { value.slots[0].id = ID_B },
    (value) => { value.slots[0].iv = flip(value.slots[0].iv) },
    (value) => { value.slots[0].key = flip(value.slots[0].key) }
  ]) {
    const damaged = clone(fixture.envelope)
    mutate(damaged)
    // A bad wrapper tag and an unknown password are deliberately indistinguishable.
    await assert.rejects(openEnvelope(damaged, 'Public password A'), WalletPasswordError)
    await assert.rejects(decryptPayload(damaged, fixture.key), WalletEnvelopeAuthenticationError)
  }
  assert.throws(() => parseEnvelope(JSON.stringify(fixture.envelope), 'different-secret'), WalletEnvelopeFormatError)
})

test('strict parser rejects extra keys, malformed hex, invalid lengths, IDs, KDF parameters, and oversized data', async (context) => {
  const derivations = []
  const original = globalThis.crypto.subtle.deriveKey.bind(globalThis.crypto.subtle)
  context.mock.method(globalThis.crypto.subtle, 'deriveKey', (...args) => { derivations.push(args); return original(...args) })
  const mutations = [
    (value) => { value.extra = true },
    (value) => { value.format = 'airgap-wallet-access-v1' },
    (value) => { value.secretId = '' },
    (value) => { value.kdf.iterations = 220001 },
    (value) => { value.kdf.iterations = 1 },
    (value) => { value.kdf.algorithm = 'pbkdf2-sha256' },
    (value) => { value.kdf.salt = '00'.repeat(15) },
    (value) => { value.kdf.extra = true },
    (value) => { value.slots = [] },
    (value) => { value.slots.push(clone(value.slots[0])) },
    (value) => { value.slots[0].id = 'not-hex' },
    (value) => { value.slots[0].key = '00'.repeat(47) },
    (value) => { value.slots[0].iv = 'AA'.repeat(12) },
    (value) => { value.slots[0].extra = true },
    (value) => { value.payload.iv = '00'.repeat(11) },
    (value) => { value.payload.data = '0'.repeat(33) },
    (value) => { value.payload.data = '00'.repeat(15) },
    (value) => { value.payload.data = 'zz'.repeat(16) },
    (value) => { value.payload.extra = true },
    (value) => { value.payload.data = '00'.repeat(crypto.MAX_WALLET_CIPHERTEXT_BYTES + 1) }
  ]
  for (const mutate of mutations) {
    const invalid = clone(fixture.envelope)
    mutate(invalid)
    assert.throws(() => parseEnvelope(JSON.stringify(invalid), SECRET), WalletEnvelopeFormatError)
    await assert.rejects(openEnvelope(invalid, 'Public password A'), WalletEnvelopeFormatError)
    await assert.rejects(encryptPayload(invalid, fixture.key, PLAINTEXT), WalletEnvelopeFormatError)
  }
  assert.throws(() => parseEnvelope('{malformed json', SECRET), WalletEnvelopeFormatError)
  assert.throws(() => parseEnvelope(' '.repeat(crypto.MAX_WALLET_CIPHERTEXT_BYTES * 2 + 65537), SECRET), WalletEnvelopeFormatError)
  assert.equal(derivations.length, 0)
})

test('slot count limit rejects the 33rd slot before deriving any password key', async (context) => {
  const envelope = clone(fixture.envelope)
  envelope.slots = Array.from({ length: 32 }, (_, index) => ({ ...envelope.slots[0], id: index.toString(16).padStart(32, '0') }))
  assert.equal(parseEnvelope(JSON.stringify(envelope), SECRET).slots.length, 32)
  const derivations = []
  context.mock.method(globalThis.crypto.subtle, 'deriveKey', () => { derivations.push(true); assert.fail('Must reject before deriving') })
  await assert.rejects(addKeySlot(envelope, fixture.key, 'ff'.repeat(16), 'Public password'), WalletEnvelopeFormatError)
  envelope.slots.push({ ...envelope.slots[0], id: 'ff'.repeat(16) })
  assert.throws(() => parseEnvelope(JSON.stringify(envelope), SECRET), WalletEnvelopeFormatError)
  assert.equal(derivations.length, 0)
})

test('passwords use raw UTF-8 without trimming or normalization and enforce byte limits', async () => {
  const password = ' é public password '
  const fixture = await createEnvelope(SECRET, ID_A, password, '')
  try {
    const opened = await openEnvelope(fixture.envelope, password)
    assert.equal(opened.plaintext, '')
    opened.key.fill(0)
    for (const different of [password.trim(), password.normalize('NFD')]) {
      await assert.rejects(openEnvelope(fixture.envelope, different), WalletPasswordError)
    }
    for (const invalid of ['', 'a'.repeat(1025), 'é'.repeat(513), '\ud800', '\udc00', null]) {
      await assert.rejects(openEnvelope(fixture.envelope, invalid), TypeError)
    }
    const maxPassword = '😀'.repeat(256)
    const maximum = await createEnvelope(SECRET, ID_A, maxPassword, '')
    const maxOpened = await openEnvelope(maximum.envelope, maxPassword)
    maxOpened.key.fill(0)
    maximum.key.fill(0)
  } finally { fixture.key.fill(0) }
})

test('payload bounds apply to UTF-8 bytes and ciphertext; new encryption uses fresh nonces', async () => {
  const refreshed = await encryptPayload(fixture.envelope, fixture.key, PLAINTEXT)
  assert.notEqual(refreshed.payload.iv, fixture.envelope.payload.iv)
  assert.notEqual(refreshed.payload.data, fixture.envelope.payload.data)
  const another = await createEnvelope(SECRET, ID_A, 'Public password A', PLAINTEXT)
  assert.notEqual(another.envelope.kdf.salt, fixture.envelope.kdf.salt)
  assert.notDeepEqual(another.key, fixture.key)
  assert.notEqual(another.envelope.slots[0].iv, fixture.envelope.slots[0].iv)
  another.key.fill(0)
  await assert.rejects(encryptPayload(fixture.envelope, fixture.key, 'a'.repeat(crypto.MAX_WALLET_PLAINTEXT_BYTES + 1)), TypeError)
  await assert.rejects(encryptPayload(fixture.envelope, fixture.key, 'é'.repeat(Math.floor(crypto.MAX_WALLET_PLAINTEXT_BYTES / 2) + 1)), TypeError)
  for (const invalidKey of [new Uint8Array(31), new Uint8Array(33), '00'.repeat(32)]) {
    await assert.rejects(decryptPayload(fixture.envelope, invalidKey), TypeError)
  }
  const atLimit = 'a'.repeat(crypto.MAX_WALLET_PLAINTEXT_BYTES)
  const maximum = await encryptPayload(fixture.envelope, fixture.key, atLimit)
  assert.equal(maximum.payload.data.length / 2, crypto.MAX_WALLET_CIPHERTEXT_BYTES)
  assert.equal(await decryptPayload(maximum, fixture.key), atLimit)
})

test('derived and imported CryptoKeys are nonextractable; temporary password and DEK copies are zeroed', async (context) => {
  const subtle = globalThis.crypto.subtle
  const importOriginal = subtle.importKey.bind(subtle)
  const deriveOriginal = subtle.deriveKey.bind(subtle)
  const imports = [], derived = []
  context.mock.method(subtle, 'importKey', async (...args) => {
    const key = await importOriginal(...args)
    imports.push({ bytes: args[1], key })
    return key
  })
  context.mock.method(subtle, 'deriveKey', async (...args) => {
    const key = await deriveOriginal(...args)
    derived.push(key)
    return key
  })
  const opened = await openEnvelope(fixture.envelope, 'Public password A')
  opened.key.fill(0)
  assert.equal(derived.length, 1)
  assert.equal(imports.length, 2)
  for (const { bytes, key } of imports) {
    assert.equal(key.extractable, false)
    assert.ok(Array.from(bytes).every((byte) => byte === 0))
  }
  assert.equal(derived[0].extractable, false)
  assert.ok(fixture.key.some((byte) => byte !== 0), 'Caller-owned DEK must remain available until lock')
})

test('unsupported Web Crypto failures propagate instead of masquerading as incorrect passwords', async (context) => {
  const failure = new TypeError('Public test provider failure')
  context.mock.method(globalThis.crypto.subtle, 'decrypt', async () => { throw failure })
  await assert.rejects(openEnvelope(fixture.envelope, 'Public password A'), (error) => error === failure)
})
