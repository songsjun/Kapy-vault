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
const { SecretsService } = load('src/app/services/secrets/secrets.service.ts')
const { MnemonicSecret } = load('src/app/models/secret.ts')
const ENTROPY = '00000000000000000000000000000000'
const DEFAULT = 'default access password'
const PI = 'separate derived wallet password'

function fixture(initial = [], initializationBarrier) {
  const native = new Map()
  const calls = { nativeGets: 0, entropyReads: 0, protocolGets: 0, derivations: 0 }
  let beforeRead
  let beforeRecovery
  let recoverySnapshot
  const secure = { async get(alias) {
    calls.nativeGets++
    return {
      async getItem(key) {
        if (beforeRead) await beforeRead(key)
        if (key === alias) calls.entropyReads++
        const value = native.get(`${alias}:${key}`)
        if (value === undefined) throw new Error('Test native item does not exist')
        return { value }
      },
      async setItem(key, value) { native.set(`${alias}:${key}`, value) },
      async removeItem(key) { native.delete(`${alias}:${key}`) },
      async setupRecoveryPassword(_key, payload) {
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
    metadata: () => metadata, recoverySnapshot: () => recoverySnapshot, beforeRead: (hook) => { beforeRead = hook }, beforeRecovery: (hook) => { beforeRecovery = hook } }
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

test('registration does not derive accounts; only salted verifiers and configurations are stored', async () => {
  const f = fixture()
  const secret = await create(f)
  const count = f.calls.derivations
  await f.access.registerPassphrase(secret, PI)
  assert.equal(f.calls.derivations, count)
  const registry = JSON.parse(f.native.get(`${secret.id}:${secret.id}`)).registry
  assert.equal(registry.entries.length, 2)
  assert.notEqual(registry.entries[0].verifier.salt, registry.entries[1].verifier.salt)
  assert.deepEqual(registry.entries[1].accounts, [])
  const record = JSON.stringify(registry)
  assert.ok(!record.includes(PI) && !record.includes(DEFAULT))
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
  const reads = f.calls.entropyReads
  const derives = f.calls.derivations
  await assert.rejects(f.access.unlock(secret, 'not registered'), /Incorrect wallet password/)
  // The single encrypted native record contains both the registry and entropy.
  assert.equal(f.calls.entropyReads, reads + 1)
  assert.equal(f.calls.derivations, derives)
  assert.equal(f.access.isUnlocked(), false)
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
  await f.access.changeDefaultPassword(secret, 'replacement default')
  await assert.rejects(f.access.unlock(secret, DEFAULT), /Incorrect/)
  await f.access.unlock(secret, 'replacement default')
  assert.equal(f.access.getWallets()[0].publicKey, expected)
  await f.access.unlock(secret, PI)
  assert.equal(f.access.getPassphrase(), PI)
})

test('duplicate credentials are rejected and concurrent registrations cannot overwrite each other', async () => {
  const f = fixture()
  const secret = await create(f)
  await assert.rejects(f.access.registerPassphrase(secret, DEFAULT), /already registered/)
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
    if (key === secret.id) { entered(); await new Promise((resolve) => { release = resolve }) }
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

test('corrupted registry format fails closed without interpreting a password as a new wallet', async () => {
  const f = fixture()
  const secret = await create(f)
  f.native.set(`${secret.id}:${secret.id}`, JSON.stringify({ format: 'airgap-wallet-access-v1', secretId: secret.id, entropy: ENTROPY,
    registry: { version: 1, secretId: 'another Secret', entries: [] } }))
  await assert.rejects(f.access.unlock(secret, DEFAULT), /Invalid wallet password registry/)
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

test('one native recovery snapshot restores entropy, registered passwords and account templates together', async () => {
  const f = fixture()
  const secret = await create(f)
  await f.access.registerPassphrase(secret, PI)
  await f.access.unlock(secret, PI)
  const wallet = await add(f, secret)
  const expected = wallet.publicKey
  await f.access.unlock(secret, DEFAULT)
  await f.service.resetRecoveryPassword(secret)
  const snapshot = f.recoverySnapshot()
  assert.equal(JSON.parse(snapshot).format, 'airgap-wallet-access-v1')
  assert.equal(JSON.parse(snapshot).registry.entries.length, 2)
  assert.equal(JSON.parse(snapshot).entropy, ENTROPY)
  f.access.lock()
  f.native.clear()
  // Simulate the original native single-item recovery returning its saved string.
  f.native.set(`${secret.id}:${secret.id}`, snapshot)
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
  assert.equal(JSON.parse(f.recoverySnapshot()).registry.entries.length, 1)
  await f.service.resetRecoveryPassword(secret)
  assert.equal(JSON.parse(f.recoverySnapshot()).registry.entries.length, 2)
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
