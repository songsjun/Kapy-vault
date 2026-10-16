// Public zero-entropy vector only. These tests execute the actual migration service.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const bip39 = require('bip39')
const { AirGapWalletStatus } = require('@airgap/coinlib-core')
const { BIP32Factory } = require('@airgap/coinlib-core/dependencies/src/bip32-5.0.1/src/index')
const ecc = require('@airgap/coinlib-core/dependencies/src/@bitcoinerlab/secp256k1-1.2.0/src/index')
const entropy = '00000000000000000000000000000000'
const mnemonic = bip39.entropyToMnemonic(entropy)
function load() {
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/app/services/migration/migration.service.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)((name) => {
    if (name === '@angular/core') return { Injectable: () => () => undefined }
    if (name.endsWith('/utils/migration')) return { isSecretMigrated: value => Boolean(value.fingerprint), isWalletMigrated: value => Boolean(value.masterFingerprint) }
    if (name.endsWith('error-handler.service')) return { ErrorCategory: {}, handleErrorLocal: () => () => undefined }
    if (name.startsWith('.')) return {}
    return require(name)
  }, module, module.exports)
  return module.exports.MigrationService
}
const MigrationService = load()
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
function fixture(passphrase = '', hd = false) {
  let epoch = 1, open = true
  const calls = { entropy: 0, derivations: [], updates: 0, metadata: 0, navigation: 0 }
  const secret = { id: 'PUBLIC-SECRET', walletAccessVersion: 2 }
  const wallet = { publicKey: 'PUBLIC-OWNED-KEY', derivationPath: "m/48'/1'/0'/2'", isExtendedPublicKey: hd, status: AirGapWalletStatus.HIDDEN }
  const protocol = {
    async getPublicKeyFromMnemonic(phrase, path, password) { calls.derivations.push({ phrase, path, password, hd: false }); return wallet.publicKey },
    async getExtendedPublicKeyFromMnemonic(phrase, path, password) { calls.derivations.push({ phrase, path, password, hd: true }); return wallet.publicKey }
  }
  wallet.protocol = protocol
  const access = {
    getContextId() { if (!open) throw Error('Wallet closed'); return epoch },
    assertContext(captured) { if (!open || captured !== epoch) throw Error('Wallet context changed') },
    requireDefault(candidate) { if (!open || candidate !== secret || passphrase !== '') throw Error('Default wallet required') },
    isConfigured(candidate) { return candidate?.walletAccessVersion === 2 },
    assertWallet(candidate, owner) { if (!open || candidate !== wallet || (owner && owner !== secret)) throw Error('Foreign account') },
    getCurrentSecret() { return open ? secret : undefined },
    getPassphrase() { if (!open) throw Error('Wallet closed'); return passphrase },
    async updateAccount(candidate) { access.assertWallet(candidate); calls.updates++ },
    changeProfile() { epoch++; open = true },
    lock() { epoch++; open = false }
  }
  const secrets = {
    async retrieveEntropyForSecret(candidate) { assert.equal(candidate, secret); calls.entropy++; return entropy },
    async addOrUpdateSecret(candidate) { access.requireDefault(candidate); calls.metadata++ }
  }
  const navigation = { async routeWithState() { calls.navigation++; return true } }
  const service = new MigrationService(secrets, navigation, access)
  return { service, secret, wallet, protocol, secrets, access, calls }
}
for (const passphrase of ['', 'PUBLIC-REGISTERED-PI']) {
  for (const hd of [false, true]) {
    test(`${passphrase ? 'Pi' : 'D'} ${hd ? 'HD' : 'single'}: migration derives from the opened profile and ignores injected passwords/mnemonics`, async () => {
      const setup = fixture(passphrase, hd)
      await setup.service.migrateWallet(setup.wallet, { persist: true, mnemonic: 'UNTRUSTED-MNEMONIC', bip39Passphrase: 'UNTRUSTED-PASSWORD' })
      assert.deepEqual(setup.calls.derivations, [{ phrase: mnemonic, path: setup.wallet.derivationPath, password: passphrase, hd }])
      const expected = BIP32Factory(ecc).fromSeed(bip39.mnemonicToSeedSync(mnemonic, passphrase)).fingerprint
      assert.equal(setup.wallet.masterFingerprint, Buffer.from(expected).toString('hex'))
      assert.equal(setup.wallet.status, AirGapWalletStatus.ACTIVE)
      assert.equal(setup.calls.updates, 1)
    })
  }
}
test('root metadata migration requires D and preserves a password-independent Secret identity', async () => {
  const branch = fixture('PUBLIC-REGISTERED-PI')
  await assert.rejects(branch.service.migrateSecret(branch.secret), /Default/)
  assert.equal(branch.calls.entropy, 0)
  const setup = fixture()
  await setup.service.migrateSecret(setup.secret, { persist: true })
  const expected = BIP32Factory(ecc).fromSeed(bip39.mnemonicToSeedSync(mnemonic)).fingerprint
  assert.equal(setup.secret.fingerprint, Buffer.from(expected).toString('hex'))
  assert.equal(setup.calls.metadata, 1)
})
test('foreign or unconfigured legacy accounts are refused before reading entropy', async () => {
  const setup = fixture()
  await assert.rejects(setup.service.migrateWallet({ ...setup.wallet }), /Foreign/)
  setup.secret.walletAccessVersion = undefined
  await assert.rejects(setup.service.migrateWallet(setup.wallet), /Re-import/)
  assert.equal(setup.calls.entropy, 0)
})
for (const boundary of ['entropy', 'public key']) {
  for (const transition of ['lock', 'changeProfile']) {
    test(`${transition} during ${boundary} lookup cannot mutate an old account or publish metadata`, async () => {
      const setup = fixture('PUBLIC-REGISTERED-PI')
      const pending = deferred(), entered = deferred()
      if (boundary === 'entropy') setup.secrets.retrieveEntropyForSecret = async () => { entered.resolve(); return pending.promise }
      else setup.protocol.getPublicKeyFromMnemonic = async () => { entered.resolve(); return pending.promise }
      const operation = setup.service.migrateWallet(setup.wallet, { persist: true })
      await entered.promise
      setup.access[transition]()
      pending.resolve(boundary === 'entropy' ? entropy : setup.wallet.publicKey)
      await assert.rejects(operation, /changed/)
      assert.equal(setup.wallet.masterFingerprint, undefined)
      assert.equal(setup.wallet.status, AirGapWalletStatus.HIDDEN)
      assert.equal(setup.calls.updates, 0)
    })
  }
}
test('a mismatched derived public key cannot alter the account', async () => {
  const setup = fixture()
  setup.protocol.getPublicKeyFromMnemonic = async () => 'PUBLIC-FOREIGN-KEY'
  await assert.rejects(setup.service.migrateWallet(setup.wallet, { persist: true }), /does not belong/)
  assert.equal(setup.wallet.masterFingerprint, undefined)
  assert.equal(setup.wallet.status, AirGapWalletStatus.HIDDEN)
  assert.equal(setup.calls.updates, 0)
})
test('context change during root entropy lookup cannot refill Secret metadata', async () => {
  const setup = fixture(), pending = deferred(), entered = deferred()
  setup.secrets.retrieveEntropyForSecret = async () => { entered.resolve(); return pending.promise }
  const operation = setup.service.migrateSecret(setup.secret, { persist: true })
  await entered.promise
  setup.access.changeProfile()
  pending.resolve(entropy)
  await assert.rejects(operation, /changed/)
  assert.equal(setup.secret.fingerprint, undefined)
  assert.equal(setup.calls.metadata, 0)
})
test('migration pages do not collect a second arbitrary BIP39 password', () => {
  const page = fs.readFileSync(path.resolve(__dirname, '../src/app/pages/migration/migration.page.ts'), 'utf8')
  const effects = fs.readFileSync(path.resolve(__dirname, '../src/app/pages/migration/migration.effects.ts'), 'utf8')
  assert.equal(page.includes("type: 'password'"), false)
  assert.equal(effects.includes('askForBip39Passphrase'), false)
  assert.equal(effects.includes('bip39Passphrase, persist:'), false)
})
