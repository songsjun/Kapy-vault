const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const { EthereumProtocol } = require('@airgap/ethereum/v0')
const { PolkadotProtocol } = require('@airgap/polkadot/v0')
const { BitcoinProtocol } = require('@airgap/bitcoin/v0')
const { AirGapWalletStatus } = require('@airgap/coinlib-core')
const { entropyToMnemonic } = require('bip39')
const load = require('./helpers/source-loader.cjs')({
  [path.resolve(__dirname, '../src/app/services/storage/storage.service')]: { VaultStorageKey: { AIRGAP_SECRET_LIST: 'airgap-secret-list' } },
  [path.resolve(__dirname, '../src/app/services/error-handler/error-handler.service')]: { ErrorCategory: {}, handleErrorLocal: () => () => {} }
})
const { WalletAccessService } = load('src/app/services/wallet-access/wallet-access.service.ts')
const crypto = load('src/app/services/wallet-access/wallet-secret-crypto.ts')
const { SecretsService } = load('src/app/services/secrets/secrets.service.ts')
const { MnemonicSecret } = load('src/app/models/secret.ts')
const ENTROPY = '00000000000000000000000000000000'
const DEFAULT = 'default access password'
const PI = 'separate derived wallet password'

function fixture(initial = [], initializationBarrier) {
  const native = new Map()
  const calls = { nativeGets: 0, envelopeReads: 0, protocolGets: 0, derivations: 0, native: [] }
  let beforeRead
  let beforeWrite
  let beforeRecovery
  let recoverySnapshot
  const secure = { async get(alias, isParanoia) {
    calls.nativeGets++
    calls.native.push({ method: 'get', alias, isParanoia })
    assert.equal(isParanoia, false, 'v2 uses the native normal mode')
    assert.match(alias, /^wallet-v2-/)
    return {
      async getItem(key) {
        assert.equal(key, alias, 'v2 native key and alias must agree')
        calls.native.push({ method: 'getItem', alias, key, isParanoia })
        if (beforeRead) await beforeRead(key)
        calls.envelopeReads++
        const value = native.get(`${alias}:${key}`)
        if (value === undefined) throw new Error('Test native item does not exist')
        return { value }
      },
      async setItem(key, value) {
        assert.equal(key, alias)
        calls.native.push({ method: 'setItem', alias, key, isParanoia })
        if (beforeWrite) await beforeWrite(key, value)
        native.set(`${alias}:${key}`, value)
      },
      async removeItem(key) {
        assert.equal(key, alias)
        calls.native.push({ method: 'removeItem', alias, key, isParanoia })
        native.delete(`${alias}:${key}`)
      },
      async setupRecoveryPassword(key, payload) {
        assert.equal(key, alias)
        calls.native.push({ method: 'setupRecoveryPassword', alias, key, isParanoia })
        recoverySnapshot = payload
        if (beforeRecovery) await beforeRecovery()
        return { recoveryKey: 'public recovery test result' }
      }
    }
  } }
  const protocols = new Map([['eth', new EthereumProtocol()], ['polkadot', new PolkadotProtocol()], ['btc', new BitcoinProtocol()]])
  for (const protocol of protocols.values()) {
    for (const method of ['getPublicKeyFromMnemonic', 'getExtendedPublicKeyFromMnemonic']) {
      const original = protocol[method].bind(protocol)
      protocol[method] = (...args) => { calls.derivations++; return original(...args) }
    }
  }
  const provider = { async getProtocol(id, network) {
    calls.protocolGets++
    const protocol = protocols.get(id)
    assert.ok(protocol, `Test protocol ${id} exists`)
    if (network) assert.equal((await protocol.getOptions()).network.identifier, network)
    return protocol
  } }
  let metadata = structuredClone(initial)
  const storage = { async get() { if (initializationBarrier) await initializationBarrier; return structuredClone(metadata) }, async set(_key, value) { metadata = JSON.parse(JSON.stringify(value)) } }
  const access = new WalletAccessService(secure, provider)
  const service = new SecretsService(secure, storage, provider, { async routeToSecretsTab() {} },
    { async create() { return { async present() {}, async dismiss() {} } } }, { instant: (value) => value },
    { async create() { return { async present() {} } } }, access)
  return { access, service, native, calls, provider, secure, storage, protocols,
    metadata: () => metadata, recoverySnapshot: () => recoverySnapshot,
    beforeRead: (hook) => { beforeRead = hook }, beforeWrite: (hook) => { beforeWrite = hook }, beforeRecovery: (hook) => { beforeRecovery = hook } }
}

function nativeKey(secret) { return `wallet-v2-${secret.id}:wallet-v2-${secret.id}` }
function envelope(f, secret) { return JSON.parse(f.native.get(nativeKey(secret))) }
function assertCiphertext(value, passwords = [DEFAULT, PI]) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  assert.ok(!serialized.includes(ENTROPY), 'native storage must not expose the test entropy')
  assert.ok(!serialized.includes(entropyToMnemonic(ENTROPY)), 'native storage must not expose the mnemonic')
  for (const password of passwords) assert.ok(!serialized.includes(password), 'native storage must not contain a wallet password')
  for (const name of ['entropy', 'registry', 'plaintext', 'verifier']) {
    assert.ok(!serialized.includes(`"${name}"`), `native storage must not expose ${name}`)
  }
}
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

// Pause after the actual WebCrypto implementation has completed. No cryptographic
// primitive is stubbed; the extra await makes cancellation deterministic.
function pauseCryptoResult(method) {
  const original = crypto[method]
  const reached = deferred()
  const resume = deferred()
  crypto[method] = async (...args) => {
    const result = await original(...args)
    reached.resolve(result)
    await resume.promise
    return result
  }
  return { reached: reached.promise, release: resume.resolve, restore: () => { crypto[method] = original } }
}

async function create(f, entropy = ENTROPY) {
  const secret = new MnemonicSecret(entropy, 'Public test Secret')
  await f.service.createSecret(secret, DEFAULT)
  return secret
}
async function add(f, secret, id = 'eth') {
  const protocol = f.protocols.get(id)
  return (await f.service.addWallets(secret, [{ protocolIdentifier: id, isHDWallet: id === 'btc',
    customDerivationPath: await protocol.getStandardDerivationPath(), isActive: true }]))[0]
}

test('listing existing Secrets performs no native reads or protocol restoration', async () => {
  const f = fixture([{ id: 'legacy', label: 'Existing', wallets: [{ publicKey: 'keep old account', protocolIdentifier: 'eth' }] }])
  await f.service.isReady()
  assert.equal(f.calls.nativeGets, 0)
  assert.equal(f.calls.protocolGets, 0)
  assert.deepEqual(f.service.getWallets(), [])
  assert.equal(f.service.getActiveSecret(), undefined)
})

test('a default password is mandatory and empty input never saves a Secret', async () => {
  const f = fixture()
  await assert.rejects(f.service.createSecret(new MnemonicSecret(ENTROPY), ''), /non-empty/)
  assert.deepEqual(f.metadata(), [])
  assert.equal(f.native.size, 0)
})

test('default password opens the original empty-passphrase ETH account', async () => {
  const f = fixture()
  const secret = await create(f)
  assert.equal(f.calls.derivations, 0)
  const wallet = await add(f, secret)
  const protocol = f.protocols.get('eth')
  const expected = await protocol.getPublicKeyFromMnemonic(entropyToMnemonic(ENTROPY), wallet.derivationPath, '')
  const wrong = await protocol.getPublicKeyFromMnemonic(entropyToMnemonic(ENTROPY), wallet.derivationPath, DEFAULT)
  assert.equal(wallet.publicKey, expected)
  assert.notEqual(wallet.publicKey, wrong)
})

test('registration does not derive or open accounts and native storage contains only encrypted data and key slots', async () => {
  const f = fixture()
  const secret = await create(f)
  const count = f.calls.derivations
  await f.access.registerPassphrase(secret, PI)
  assert.equal(f.calls.derivations, count)
  const stored = envelope(f, secret)
  assert.equal(stored.format, 'airgap-wallet-access-v2')
  assert.equal(stored.kdf.algorithm, 'pbkdf2-sha512')
  assert.equal(stored.kdf.iterations, 220000)
  assert.equal(stored.slots.length, 2)
  assert.equal(new Set(stored.slots.map((slot) => slot.id)).size, 2)
  assert.equal(f.access.isDefaultUnlocked(secret), true)
  assert.deepEqual(f.access.getWallets(), [])
  assertCiphertext(stored)
  assert.ok(!JSON.stringify(f.metadata()).includes('verifier'))
})

test('Pi opens its own ETH/BTC accounts and repeat entry reproduces their keys', async () => {
  const f = fixture()
  const secret = await create(f)
  const defaultWallet = await add(f, secret)
  const defaultKey = defaultWallet.publicKey
  await f.access.registerPassphrase(secret, PI)
  await f.access.unlock(secret, PI)
  assert.deepEqual(f.access.getWallets(), [])
  const eth = await add(f, secret)
  const btc = await add(f, secret, 'btc')
  assert.notEqual(eth.publicKey, defaultKey)
  assert.equal(eth.publicKey, await f.protocols.get('eth').getPublicKeyFromMnemonic(entropyToMnemonic(ENTROPY), eth.derivationPath, PI))
  const keys = [eth.publicKey, btc.publicKey]
  f.access.lock()
  assert.deepEqual(secret.wallets, [])
  await f.access.unlock(secret, PI)
  assert.deepEqual(f.access.getWallets().map((wallet) => wallet.publicKey), keys)
  await f.access.unlock(secret, DEFAULT)
  assert.deepEqual(f.access.getWallets().map((wallet) => wallet.publicKey), [defaultKey])
})

test('unknown password never derives accounts or grants access to the encrypted Secret', async () => {
  const f = fixture()
  const secret = await create(f)
  await add(f, secret)
  const reads = f.calls.envelopeReads
  const derives = f.calls.derivations
  await assert.rejects(f.access.unlock(secret, 'not registered'), /Incorrect wallet password/)
  // Reading ciphertext is necessary to try a key slot; it grants no entropy access.
  assert.equal(f.calls.envelopeReads, reads + 1)
  assert.equal(f.calls.derivations, derives)
  assert.equal(f.access.isUnlocked(), false)
  await assert.rejects(f.service.retrieveEntropyForSecret(secret), /Open the Secret/)
  assert.deepEqual(secret.wallets, [])
})

test('ordinary persisted metadata never acquires runtime public keys or addresses', async () => {
  const f = fixture()
  const secret = await create(f)
  const wallet = await add(f, secret)
  await f.service.addOrUpdateSecret(secret)
  const metadata = JSON.stringify(f.metadata())
  assert.deepEqual(f.metadata()[0].wallets, [])
  assert.ok(!metadata.includes(wallet.publicKey))
  assert.ok(!metadata.includes(ENTROPY))
  assert.ok(!metadata.includes(DEFAULT) && !metadata.includes('verifier'))
  const restarted = new WalletAccessService(f.secure, f.provider)
  await restarted.unlock(MnemonicSecret.init(f.metadata()[0]), DEFAULT)
  assert.equal(restarted.getWallets()[0].publicKey, wallet.publicKey)
})

test('raw Unicode passphrases preserve original DOT derivation behavior', async () => {
  const f = fixture()
  const secret = await create(f)
  const inputs = ['caf\u00e9', 'cafe\u0301']
  for (const input of inputs) await f.access.registerPassphrase(secret, input)
  const keys = []
  for (const input of inputs) {
    await f.access.unlock(secret, input)
    const wallet = await add(f, secret, 'polkadot')
    assert.equal(wallet.publicKey, await f.protocols.get('polkadot').getPublicKeyFromMnemonic(entropyToMnemonic(ENTROPY), wallet.derivationPath, input))
    keys.push(wallet.publicKey)
  }
  assert.notEqual(keys[0], keys[1])
})

test('Pi cannot register passwords, change D, remove a Secret or access another Secret', async () => {
  const f = fixture()
  const secret = await create(f)
  await f.access.registerPassphrase(secret, PI)
  await f.access.unlock(secret, PI)
  await assert.rejects(f.access.registerPassphrase(secret, 'new'), /default wallet password/)
  await assert.rejects(f.access.changeDefaultPassword(secret, 'new'), /default wallet password/)
  await assert.rejects(f.service.remove(secret), /default wallet password/)
  assert.throws(() => f.access.requireUnlocked(new MnemonicSecret('11111111111111111111111111111111')), /Open the Secret/)
})

test('changing D preserves original addresses and does not change Pi', async () => {
  const f = fixture()
  const secret = await create(f)
  const wallet = await add(f, secret)
  const expected = wallet.publicKey
  await f.access.registerPassphrase(secret, PI)
  await f.access.unlock(secret, PI)
  const piWallet = await add(f, secret)
  const piKey = piWallet.publicKey
  const piProfile = f.access.requireUnlocked().profileId
  await f.access.unlock(secret, DEFAULT)
  const defaultProfile = f.access.requireUnlocked().profileId
  const originalPiSlot = envelope(f, secret).slots.find((slot) => slot.id === piProfile)
  await f.access.changeDefaultPassword(secret, 'replacement default')
  assert.deepEqual(envelope(f, secret).slots.find((slot) => slot.id === piProfile), originalPiSlot)
  await assert.rejects(f.access.unlock(secret, DEFAULT), /Incorrect/)
  await f.access.unlock(secret, 'replacement default')
  assert.equal(f.access.requireUnlocked().profileId, defaultProfile)
  assert.equal(f.access.getPassphrase(), '')
  assert.equal(f.access.getWallets()[0].publicKey, expected)
  await f.access.unlock(secret, PI)
  assert.equal(f.access.getPassphrase(), PI)
  assert.equal(f.access.requireUnlocked().profileId, piProfile)
  assert.equal(f.access.getWallets()[0].publicKey, piKey)
  assertCiphertext(envelope(f, secret), [DEFAULT, PI, 'replacement default'])
})

test('duplicate credentials are rejected and concurrent registrations cannot overwrite each other', async () => {
  const f = fixture()
  const secret = await create(f)
  await assert.rejects(f.access.registerPassphrase(secret, DEFAULT), /already (registered|exists)/)
  await Promise.all([f.access.registerPassphrase(secret, 'first'), f.access.registerPassphrase(secret, 'second')])
  assert.equal((await f.access.listPassphrases(secret)).length, 3)
  await f.access.unlock(secret, 'first')
  await f.access.unlock(secret, 'second')
  assert.equal(f.access.isDefaultUnlocked(), false)
})

test('cancel during native registry read prevents late unlocking', async () => {
  const f = fixture()
  const secret = await create(f)
  f.access.lock()
  let release
  let entered
  const reading = new Promise((resolve) => { entered = resolve })
  f.beforeRead(async (key) => {
    if (key === `wallet-v2-${secret.id}`) { entered(); await new Promise((resolve) => { release = resolve }) }
  })
  const pending = f.access.unlock(secret, DEFAULT)
  await reading
  f.access.lock()
  release()
  await assert.rejects(pending, /cancelled/)
  assert.equal(f.access.isUnlocked(), false)
})

test('lock invalidates old context and account object even after reopening the same wallet', async () => {
  const f = fixture()
  const secret = await create(f)
  const old = await add(f, secret)
  const epoch = f.access.getContextId()
  f.access.lock()
  await f.access.unlock(secret, DEFAULT)
  assert.throws(() => f.access.assertContext(epoch), /changed/)
  assert.throws(() => f.access.assertWallet(old), /does not belong/)
  f.access.assertWallet(f.access.getWallets()[0])
})

test('bulk deletion persists every account and does not restore them as active on reopen', async () => {
  const f = fixture()
  const secret = await create(f)
  const eth = await add(f, secret)
  const btc = await add(f, secret, 'btc')
  await f.service.removeWallets([eth, btc])
  f.access.lock()
  await f.access.unlock(secret, DEFAULT)
  assert.deepEqual(f.service.getWallets(), [])
  assert.ok(f.access.getWallets().every((wallet) => wallet.status === AirGapWalletStatus.DELETED))
})

test('legacy public records are preserved without automatic migration when new Secrets are saved', async () => {
  const legacy = { id: 'legacy', label: 'Unmigrated', fingerprint: 'legacyfp', wallets: [{ publicKey: 'old public key', protocolIdentifier: 'eth' }] }
  const f = fixture([legacy])
  await create(f)
  assert.deepEqual(f.metadata().find((secret) => secret.id === 'legacy'), legacy)
})

test('a malformed encrypted envelope fails closed without interpreting a password as a new wallet', async () => {
  const f = fixture()
  const secret = await create(f)
  f.native.set(nativeKey(secret), JSON.stringify({ format: 'airgap-wallet-access-v2', secretId: 'another Secret', slots: [], payload: {} }))
  await assert.rejects(f.access.unlock(secret, DEFAULT), /Invalid|Unsupported/)
  assert.equal(f.access.isUnlocked(), false)
})

test('locking during recovery key creation prevents returning the late recovery key', async () => {
  const f = fixture()
  const secret = await create(f)
  let release
  let entered
  const started = new Promise((resolve) => { entered = resolve })
  f.beforeRecovery(async () => { entered(); await new Promise((resolve) => { release = resolve }) })
  const pending = f.service.resetRecoveryPassword(secret)
  await started
  f.access.lock()
  release()
  await assert.rejects(pending, /changed/)
  assert.notEqual(secret.hasRecoveryKey, true)
})


test('cancelling before initialization finishes prevents late Secret creation', async () => {
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const f = fixture([], barrier)
  const pending = f.service.createSecret(new MnemonicSecret(ENTROPY), DEFAULT)
  f.access.lock()
  release()
  await assert.rejects(pending, /cancelled/)
  assert.equal(f.access.isUnlocked(), false)
  assert.deepEqual(f.metadata(), [])
  assert.equal(f.native.size, 0)
})

test('one encrypted native recovery snapshot restores passwords and account templates but still requires a wallet password', async () => {
  const f = fixture()
  const secret = await create(f)
  await f.access.registerPassphrase(secret, PI)
  await f.access.unlock(secret, PI)
  const wallet = await add(f, secret)
  const expected = wallet.publicKey
  await f.access.unlock(secret, DEFAULT)
  await f.service.resetRecoveryPassword(secret)
  const snapshot = f.recoverySnapshot()
  assert.equal(JSON.parse(snapshot).format, 'airgap-wallet-access-v2')
  assert.equal(JSON.parse(snapshot).slots.length, 2)
  assertCiphertext(snapshot)
  f.access.lock()
  f.native.clear()
  // Simulate the original native single-item recovery returning its saved string.
  f.native.set(nativeKey(secret), snapshot)
  await assert.rejects(f.access.unlock(secret, 'wrong recovery wallet password'), /Incorrect/)
  await assert.rejects(f.service.retrieveEntropyForSecret(secret), /Open the Secret/)
  await f.access.unlock(secret, PI)
  assert.equal(f.access.getWallets()[0].publicKey, expected)
  assert.equal(await f.service.retrieveEntropyForSecret(secret), ENTROPY)
})

test('changing registered credentials marks the previous recovery snapshot as outdated in public metadata', async () => {
  const f = fixture()
  const secret = await create(f)
  await f.service.resetRecoveryPassword(secret)
  assert.equal(secret.hasRecoveryKey, true)
  assert.equal(f.metadata()[0].hasRecoveryKey, true)
  await f.access.registerPassphrase(secret, PI)
  assert.equal(secret.hasRecoveryKey, false)
  assert.equal(f.metadata()[0].hasRecoveryKey, false)
  // No promise of revoking old copies: native recovery remains a point-in-time snapshot.
  assert.equal(JSON.parse(f.recoverySnapshot()).slots.length, 1)
  await f.service.resetRecoveryPassword(secret)
  assert.equal(JSON.parse(f.recoverySnapshot()).slots.length, 2)
  assert.equal(f.metadata()[0].hasRecoveryKey, true)
})

test('failed public metadata save keeps the draft retryable without publishing an unlocked wallet', async () => {
  const f = fixture()
  await f.service.isReady()
  const draft = new MnemonicSecret(ENTROPY)
  const save = f.storage.set
  f.storage.set = async () => { throw new Error('Test metadata write failure') }
  await assert.rejects(f.service.createSecret(draft, DEFAULT), /metadata write failure/)
  assert.equal(draft.secretHex, ENTROPY)
  assert.equal(f.access.isConfigured(draft), false)
  assert.equal(f.access.isUnlocked(), false)
  assert.deepEqual(f.metadata(), [])
  f.storage.set = save
  await f.service.createSecret(draft, DEFAULT)
  assert.equal(f.access.isDefaultUnlocked(draft), true)
  assert.equal(f.metadata().length, 1)
})

test('fresh Secrets use version 2 and only the independent native normal-mode alias through recovery and deletion', async () => {
  const f = fixture()
  const secret = new MnemonicSecret(ENTROPY)
  secret.isParanoia = true
  await f.service.createSecret(secret, DEFAULT)
  assert.equal(secret.walletAccessVersion, 2)
  assert.equal(secret.isParanoia, false)
  assert.deepEqual(f.access.getStorageLocation(secret), { alias: `wallet-v2-${secret.id}`, key: `wallet-v2-${secret.id}`, isParanoia: false })
  await f.service.resetRecoveryPassword(secret)
  await f.access.registerPassphrase(secret, PI)
  await f.service.remove(secret)
  assert.equal(f.native.size, 0)
  assert.deepEqual(f.metadata(), [])
  assert.equal(f.access.isUnlocked(), false)
  assert.ok(f.calls.native.some((call) => call.method === 'setupRecoveryPassword'))
  assert.ok(f.calls.native.some((call) => call.method === 'removeItem'))
  for (const call of f.calls.native) {
    assert.equal(call.alias, `wallet-v2-${secret.id}`)
    assert.equal(call.isParanoia, false)
    if (call.key) assert.equal(call.key, `wallet-v2-${secret.id}`)
  }
})

test('entropy reads preserve native authentication while account commits use the current encrypted session', async () => {
  const f = fixture()
  const secret = await create(f)
  const reads = f.calls.envelopeReads
  assert.equal(await f.service.retrieveEntropyForSecret(secret), ENTROPY)
  assert.equal(await f.service.retrieveEntropyForSecret(secret), ENTROPY)
  assert.equal(f.calls.envelopeReads, reads + 2)
  const wallet = await add(f, secret)
  assert.equal(f.calls.envelopeReads, reads + 3, 'adding an account must also authorize the entropy read')
  wallet.status = AirGapWalletStatus.HIDDEN
  await f.access.updateAccount(wallet)
  assert.equal(f.calls.envelopeReads, reads + 3, 'account-only commit must not reread native entropy')
  assertCiphertext(envelope(f, secret))
  assert.ok(!JSON.stringify(envelope(f, secret)).includes(wallet.publicKey))
})

test('an unlocked session cannot disclose entropy or derive a new account when the native read is refused', async () => {
  const f = fixture()
  const secret = await create(f)
  const derivations = f.calls.derivations
  const before = f.native.get(nativeKey(secret))
  f.beforeRead(async () => { throw new Error('Test native authentication refused') })
  await assert.rejects(f.service.retrieveEntropyForSecret(secret), /native authentication refused/)
  await assert.rejects(add(f, secret), /native authentication refused/)
  assert.equal(f.calls.derivations, derivations)
  assert.deepEqual(f.access.getWallets(), [])
  assert.equal(f.native.get(nativeKey(secret)), before)
  f.beforeRead(undefined)
  assert.equal(await f.service.retrieveEntropyForSecret(secret), ENTROPY)
})

test('lock while the entropy native read is pending rejects its late result before payload decryption', async () => {
  const f = fixture()
  const secret = await create(f)
  const entered = deferred()
  const resume = deferred()
  let decryptions = 0
  const original = crypto.decryptPayload
  crypto.decryptPayload = (...args) => { decryptions++; return original(...args) }
  f.beforeRead(async () => { entered.resolve(); await resume.promise })
  try {
    const pending = f.service.retrieveEntropyForSecret(secret)
    await entered.promise
    f.access.lock()
    resume.resolve()
    await assert.rejects(pending, /changed/)
    assert.equal(decryptions, 0)
    assert.equal(f.access.isUnlocked(), false)
  } finally {
    resume.resolve()
    crypto.decryptPayload = original
  }
})

test('removing Pi removes its decrypting slot and accounts while the default branch keeps its original address', async () => {
  const f = fixture()
  const secret = await create(f)
  const defaultKey = (await add(f, secret)).publicKey
  await f.access.registerPassphrase(secret, PI)
  const piId = (await f.access.listPassphrases(secret)).find((entry) => !entry.isDefault).id
  await f.access.unlock(secret, PI)
  const piKey = (await add(f, secret)).publicKey
  assert.notEqual(piKey, defaultKey)
  await f.access.unlock(secret, DEFAULT)
  await f.access.removePassphrase(secret, piId)
  assert.equal(envelope(f, secret).slots.length, 1)
  assert.ok(!envelope(f, secret).slots.some((slot) => slot.id === piId))
  await assert.rejects(f.access.unlock(secret, PI), /Incorrect/)
  await f.access.unlock(secret, DEFAULT)
  assert.deepEqual(f.access.getWallets().map((wallet) => wallet.publicKey), [defaultKey])
  assert.equal(await f.service.retrieveEntropyForSecret(secret), ENTROPY)
  assert.equal((await f.access.listPassphrases(secret)).length, 1)
})

test('lock zeros the retained session data key and revokes entropy and passphrase access', async () => {
  const f = fixture()
  const secret = await create(f)
  await f.access.registerPassphrase(secret, PI)
  await f.access.unlock(secret, PI)
  // Keep the same backing buffer to distinguish overwriting from dropping a reference.
  const key = f.access.current.key
  assert.equal(key.length, 32)
  assert.ok(key.some((byte) => byte !== 0))
  f.access.lock()
  assert.ok(key.every((byte) => byte === 0))
  assert.equal(f.access.current, undefined)
  assert.throws(() => f.access.getPassphrase(secret), /Open the Secret/)
  await assert.rejects(f.service.retrieveEntropyForSecret(secret), /Open the Secret/)
})

test('cancelling after real key unwrap completes clears its data key and publishes no late context', async () => {
  const f = fixture()
  const secret = await create(f)
  f.access.lock()
  const published = []
  const subscription = f.access.changes$.subscribe((context) => { if (context) published.push(context) })
  const barrier = pauseCryptoResult('openEnvelope')
  try {
    const pending = f.access.unlock(secret, DEFAULT)
    const opened = await barrier.reached
    assert.ok(opened.key.some((byte) => byte !== 0))
    f.access.lock()
    barrier.release()
    await assert.rejects(pending, /cancelled/)
    assert.ok(opened.key.every((byte) => byte === 0))
    assert.equal(f.access.isUnlocked(), false)
    assert.deepEqual(published, [])
  } finally {
    barrier.release()
    barrier.restore()
    subscription.unsubscribe()
  }
})

test('an older unlock finishing after a newer Pi unlock cannot replace or clear the new context', async () => {
  const f = fixture()
  const secret = await create(f)
  await f.access.registerPassphrase(secret, PI)
  const barrier = pauseCryptoResult('openEnvelope')
  try {
    const older = f.access.unlock(secret, DEFAULT)
    const opened = await barrier.reached
    barrier.restore()
    await f.access.unlock(secret, PI)
    const context = f.access.requireUnlocked()
    barrier.release()
    await assert.rejects(older, /cancelled/)
    assert.ok(opened.key.every((byte) => byte === 0))
    assert.equal(f.access.requireUnlocked(), context)
    assert.equal(f.access.getPassphrase(), PI)
    assert.equal(await f.service.retrieveEntropyForSecret(secret), ENTROPY)
  } finally {
    barrier.release()
    barrier.restore()
  }
})

test('lock while a real payload decryption is pending prevents late entropy disclosure', async () => {
  const f = fixture()
  const secret = await create(f)
  const barrier = pauseCryptoResult('decryptPayload')
  try {
    const pending = f.service.retrieveEntropyForSecret(secret)
    await barrier.reached
    f.access.lock()
    barrier.release()
    await assert.rejects(pending, /changed/)
    assert.equal(f.access.isUnlocked(), false)
  } finally {
    barrier.release()
    barrier.restore()
  }
})

test('lock during key-slot creation also cancels queued registration and leaves storage unchanged', async () => {
  const f = fixture()
  const secret = await create(f)
  const before = f.native.get(nativeKey(secret))
  const barrier = pauseCryptoResult('addKeySlot')
  try {
    const pending = f.access.registerPassphrase(secret, PI)
    await barrier.reached
    const queued = f.access.registerPassphrase(secret, 'queued password')
    const checks = [assert.rejects(pending, /changed/), assert.rejects(queued, /changed/)]
    f.access.lock()
    barrier.release()
    await Promise.all(checks)
    assert.equal(f.native.get(nativeKey(secret)), before)
    assert.equal(f.access.isUnlocked(), false)
  } finally {
    barrier.release()
    barrier.restore()
  }
})

test('lock while native creation is pending cannot publish a new Secret or unlocked context', async () => {
  const f = fixture()
  const entered = deferred()
  const resume = deferred()
  f.beforeWrite(async () => { entered.resolve(); await resume.promise })
  const pending = f.service.createSecret(new MnemonicSecret(ENTROPY), DEFAULT)
  await entered.promise
  f.access.lock()
  resume.resolve()
  await assert.rejects(pending, /cancelled/)
  assert.equal(f.access.isUnlocked(), false)
  assert.deepEqual(f.metadata(), [])
  for (const record of f.native.values()) assertCiphertext(record)
})

test('a failed native password change preserves the old persisted password and does not publish the replacement', async () => {
  const f = fixture()
  const secret = await create(f)
  const before = f.native.get(nativeKey(secret))
  f.beforeWrite(async () => { throw new Error('Test native write failure') })
  await assert.rejects(f.access.changeDefaultPassword(secret, 'replacement that did not save'), /native write failure/)
  assert.equal(f.native.get(nativeKey(secret)), before)
  f.beforeWrite(undefined)
  await assert.rejects(f.access.unlock(secret, 'replacement that did not save'), /Incorrect/)
  await f.access.unlock(secret, DEFAULT)
  assert.equal(f.access.getPassphrase(), '')
})

test('tampered ciphertext, key slots and Secret headers are rejected before account derivation', async (t) => {
  const f = fixture()
  const secret = await create(f)
  await add(f, secret)
  await f.access.registerPassphrase(secret, PI)
  const original = envelope(f, secret)
  const flip = (value) => (value[0] === '0' ? '1' : '0') + value.slice(1)
  const variants = [
    ['payload ciphertext', (value) => { value.payload.data = flip(value.payload.data) }],
    ['payload nonce', (value) => { value.payload.iv = flip(value.payload.iv) }],
    ['default wrapped key', (value) => { value.slots[0].key = flip(value.slots[0].key) }],
    ['other branch wrapped key', (value) => { value.slots[1].key = flip(value.slots[1].key) }],
    ['other branch identity', (value) => { value.slots[1].id = flip(value.slots[1].id) }],
    ['slot removal without payload update', (value) => { value.slots.pop() }],
    ['different Secret', (value) => { value.secretId = 'different-secret' }],
    ['unbounded KDF parameters', (value) => { value.kdf.iterations = 2147483647 }]
  ]
  for (const [name, corrupt] of variants) {
    await t.test(name, async () => {
      const changed = structuredClone(original)
      corrupt(changed)
      f.native.set(nativeKey(secret), JSON.stringify(changed))
      const derivations = f.calls.derivations
      await assert.rejects(f.access.unlock(secret, DEFAULT), /Incorrect|Invalid|corrupted|authentication/)
      assert.equal(f.calls.derivations, derivations)
      assert.equal(f.access.isUnlocked(), false)
      await assert.rejects(f.service.retrieveEntropyForSecret(secret), /Open the Secret/)
    })
  }
  f.native.set(nativeKey(secret), JSON.stringify(original))
  await f.access.unlock(secret, DEFAULT)
  assert.equal(f.access.getWallets().length, 1)
})

test('account updates use fresh payload nonces and preserve existing password slots', async () => {
  const f = fixture()
  const secret = await create(f)
  await f.access.registerPassphrase(secret, PI)
  const before = envelope(f, secret)
  const wallet = await add(f, secret)
  const after = envelope(f, secret)
  assert.notEqual(after.payload.iv, before.payload.iv)
  assert.notEqual(after.payload.data, before.payload.data)
  assert.deepEqual(after.slots, before.slots)
  wallet.status = AirGapWalletStatus.HIDDEN
  await f.access.updateAccount(wallet)
  const updated = envelope(f, secret)
  assert.notEqual(updated.payload.iv, after.payload.iv)
  assert.deepEqual(updated.slots, before.slots)
})

test('D cannot become a registered Pi and the default password entry cannot be removed', async () => {
  const f = fixture()
  const secret = await create(f)
  await f.access.registerPassphrase(secret, PI)
  const before = f.native.get(nativeKey(secret))
  const defaultId = (await f.access.listPassphrases(secret)).find((entry) => entry.isDefault).id
  await assert.rejects(f.access.changeDefaultPassword(secret, PI), /already (registered|exists)/)
  await assert.rejects(f.access.removePassphrase(secret, defaultId), /cannot be removed/)
  assert.equal(f.native.get(nativeKey(secret)), before)
  await f.access.unlock(secret, DEFAULT)
  assert.equal(f.access.getPassphrase(), '')
})

test('lock during an issued native account write cannot republish its wallets or data key', async () => {
  const f = fixture()
  const secret = await create(f)
  const key = f.access.current.key
  const entered = deferred()
  const resume = deferred()
  f.beforeWrite(async () => { entered.resolve(); await resume.promise })
  const published = []
  const subscription = f.access.changes$.subscribe((context) => { if (context) published.push(context) })
  try {
    const pending = add(f, secret)
    await entered.promise
    published.length = 0
    f.access.lock()
    resume.resolve()
    await assert.rejects(pending, /changed/)
    assert.equal(f.access.isUnlocked(), false)
    assert.deepEqual(secret.wallets, [])
    assert.deepEqual(published, [])
    assert.ok(key.every((byte) => byte === 0))
    // An already-issued native write can finish. Its result must remain ciphertext
    // and must not restore runtime authorization after lock.
    assertCiphertext(envelope(f, secret))
  } finally {
    resume.resolve()
    subscription.unsubscribe()
  }
})

test('unlock drains an issued password write so the old D cannot open a stale session or roll back key slots', async () => {
  const f = fixture()
  const secret = await create(f)
  const expected = (await add(f, secret)).publicKey
  const entered = deferred()
  const resume = deferred()
  const replacement = 'new default after pending native write'
  f.beforeWrite(async () => { entered.resolve(); await resume.promise })
  const changing = f.access.changeDefaultPassword(secret, replacement)
  const cancelledChange = assert.rejects(changing, /changed/)
  let opening
  try {
    await entered.promise
    f.access.lock()
    const reads = f.calls.envelopeReads
    opening = f.access.unlock(secret, DEFAULT).then(
      () => ({ opened: true }),
      (error) => ({ opened: false, error })
    )
    // Flush promise work without waiting for the still-paused native operation.
    await new Promise(setImmediate)
    const readsBeforeWriteFinished = f.calls.envelopeReads - reads
    resume.resolve()
    await cancelledChange
    const result = await opening
    assert.equal(result.opened, false, 'a revoked D must not open using the pre-write envelope')
    assert.match(result.error.message, /Incorrect wallet password/)
    assert.equal(readsBeforeWriteFinished, 0, 'unlock must wait before reading a native item that an older task is writing')
    assert.equal(f.access.isUnlocked(), false)
  } finally {
    resume.resolve()
    await cancelledChange
    if (opening) await opening
    f.beforeWrite(undefined)
  }
  await f.access.unlock(secret, replacement)
  assert.equal(f.access.getWallets()[0].publicKey, expected)
  const btc = await add(f, secret, 'btc')
  const btcKey = btc.publicKey
  f.access.lock()
  await assert.rejects(f.access.unlock(secret, DEFAULT), /Incorrect wallet password/)
  await f.access.unlock(secret, replacement)
  assert.deepEqual(f.access.getWallets().map((wallet) => wallet.publicKey), [expected, btcKey])
})

test('recovery snapshot creation finishes before queued registration marks that snapshot outdated', async () => {
  const f = fixture()
  const secret = await create(f)
  const entered = deferred()
  const resume = deferred()
  f.beforeRecovery(async () => { entered.resolve(); await resume.promise })
  const metadataFlags = []
  const save = f.storage.set
  f.storage.set = async (...args) => {
    metadataFlags.push(args[1].find((record) => record.id === secret.id).hasRecoveryKey)
    return save(...args)
  }
  let registrationStarted = false
  const original = crypto.addKeySlot
  crypto.addKeySlot = (...args) => { registrationStarted = true; return original(...args) }
  const recovery = f.service.resetRecoveryPassword(secret)
  let registration
  try {
    await entered.promise
    assert.equal(JSON.parse(f.recoverySnapshot()).slots.length, 1)
    registration = f.access.registerPassphrase(secret, PI)
    await new Promise(setImmediate)
    const startedBeforeRecoveryFinished = registrationStarted
    // A broken, unserialized implementation is allowed to complete here so its
    // late recovery result also exposes the incorrect final metadata flag.
    if (startedBeforeRecoveryFinished) await registration
    resume.resolve()
    assert.equal(await recovery, 'public recovery test result')
    await registration
    assert.equal(JSON.parse(f.recoverySnapshot()).slots.length, 1)
    assert.equal(envelope(f, secret).slots.length, 2)
    assert.equal(secret.hasRecoveryKey, false)
    assert.equal(f.metadata()[0].hasRecoveryKey, false)
    assert.deepEqual(metadataFlags, [true, false])
    assert.equal(startedBeforeRecoveryFinished, false, 'registration must wait for recovery setup and its metadata update')
    assertCiphertext(f.recoverySnapshot())
  } finally {
    resume.resolve()
    await recovery
    if (registration) await registration
    crypto.addKeySlot = original
    f.storage.set = save
  }
})


test('closing a wallet during Secret creation cannot restore entropy to a cleaned draft', async () => {
  const f = fixture()
  await f.service.isReady()
  let release, entered
  const barrier = new Promise((resolve) => { release = resolve })
  const reached = new Promise((resolve) => { entered = resolve })
  const original = f.access.setup.bind(f.access)
  f.access.setup = async (...args) => { await original(...args); entered(); await barrier }
  const draft = new MnemonicSecret(ENTROPY, 'Public cancelled draft')
  const creating = f.service.createSecret(draft, DEFAULT)
  await reached
  f.access.lock()
  draft.flushSecret()
  const rejection = assert.rejects(creating)
  release()
  await rejection
  assert.equal(draft.secretHex, undefined)
  assert.equal(f.access.isUnlocked(), false)
})

// A Bitcoin HD wallet flattens all external addresses, then all internal addresses.
// Preserve the full list length so an internal selected index keeps its exact meaning.
test('reopening a Bitcoin account preserves its complete address batch and selected internal address', async () => {
  const f = fixture(), secret = await create(f), wallet = await add(f, secret, 'btc')
  wallet.addresses = await wallet.deriveAddresses(4)
  wallet.addressIndex = 4
  const addresses = [...wallet.addresses], selected = wallet.receivingPublicAddress
  await f.access.updateAccount(wallet)
  f.access.lock()
  await f.access.unlock(secret, DEFAULT)
  const restored = f.access.getWallets()[0]
  assert.deepEqual(restored.addresses, addresses)
  assert.equal(restored.addressIndex, 4)
  assert.equal(restored.receivingPublicAddress, selected)
})

async function rewriteAddressConfig(f, secret, update) {
  const opened = await crypto.openEnvelope(envelope(f, secret), DEFAULT)
  try {
    const stored = JSON.parse(opened.plaintext)
    update(stored.registry.entries[0].accounts[0])
    const sealed = await crypto.encryptPayload(envelope(f, secret), opened.key, JSON.stringify(stored))
    f.native.set(nativeKey(secret), JSON.stringify(sealed))
  } finally { opened.key.fill(0) }
  f.access.lock()
}

for (const index of [0, 1]) {
  test(`old Bitcoin configs without an address count retain the original one-per-chain index ${index}`, async () => {
    const f = fixture(), secret = await create(f), wallet = await add(f, secret, 'btc')
    const selected = wallet.addresses[index]
    await rewriteAddressConfig(f, secret, config => { delete config.addressCount; config.addressIndex = index })
    await f.access.unlock(secret, DEFAULT)
    assert.equal(f.access.getWallets()[0].receivingPublicAddress, selected)
  })
}

test('an old selected index that needs an unknown address batch is refused instead of selecting a different address', async () => {
  const f = fixture(), secret = await create(f); await add(f, secret, 'btc')
  await rewriteAddressConfig(f, secret, config => { delete config.addressCount; config.addressIndex = 4 })
  await assert.rejects(f.access.unlock(secret, DEFAULT), /original address count/)
  assert.equal(f.access.isUnlocked(), false)
})

test('stored address counts are bounded integers and the selected index must be inside the exact derived list', async () => {
  const f = fixture(), secret = await create(f); await add(f, secret, 'btc')
  const original = f.native.get(nativeKey(secret))
  for (const [count, index] of [[0, 0], [-1, 0], [1.5, 0], [10001, 0], [3, 0], [2, 2]]) {
    f.native.set(nativeKey(secret), original)
    await rewriteAddressConfig(f, secret, config => { config.addressCount = count; config.addressIndex = index })
    await assert.rejects(f.access.unlock(secret, DEFAULT), /Invalid account configuration|Invalid stored Bitcoin address count/)
    assert.equal(f.access.isUnlocked(), false)
  }
})
