const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const { EthereumProtocol } = require('@airgap/ethereum/v0/protocol/EthereumProtocol')
const { AirGapWallet, AirGapWalletStatus } = require('@airgap/coinlib-core')
const { IACMessageType } = require('@airgap/serializer')

const root = path.resolve(__dirname, '..')
function load(relative, resolve) {
  const source = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)(resolve, module, module.exports)
  return module.exports
}
const angular = { Injectable: () => () => undefined, Inject: () => () => undefined }
const ngrx = {
  createAction(type) { const action = (value = {}) => ({ ...value, type }); action.type = type; return action },
  props: () => undefined
}
const actions = load('src/app/pages/deserialized-detail/deserialized-detail.actions.ts', (name) => {
  if (name === '@ngrx/store') return ngrx
  throw Error(`Unexpected actions dependency: ${name}`)
})
const enums = load('src/app/pages/deserialized-detail/deserialized.detail.types.ts', () => { throw Error('Unexpected type dependency') })
const handler = { ErrorCategory: {}, handleErrorLocal: () => () => undefined }
const core = { QRType: { V2: 2, V3: 3 }, BaseIACService: class {}, assertNever: () => { throw Error('Unexpected payload') } }
const storage = { InteractionType: { UNDETERMINED: 0, ALWAYS_ASK: 1, DEEPLINK: 2, QR_CODE: 3 }, VaultStorageKey: { INTERACTION_TYPE: 'interaction' } }
function resolve(name) {
  if (name === '@angular/core') return angular
  if (name === '@airgap/angular-core') return core
  if (name === '@ngrx/effects') return { createEffect: () => undefined, ofType: () => undefined }
  if (name === '@ngrx/store') return ngrx
  if (name.endsWith('deserialized-detail.actions')) return actions
  if (name.endsWith('deserialized-detail.reducer')) return {}
  if (name.endsWith('deserialized.detail.types')) return enums
  if (name.includes('error-handler.service')) return handler
  if (name.endsWith('storage.service')) return storage
  if (name.endsWith('/utils/utils')) return { assertNever: core.assertNever }
  if (name.includes('select-account.page')) return { SelectAccountPage: class {} }
  if (name.startsWith('.') || name.startsWith('src/')) return {}
  return require(name)
}
const { ShareUrlService } = load('src/app/services/share-url/share-url.service.ts', resolve)
const { InteractionService, InteractionOperationType, InteractionCommunicationType } = load('src/app/services/interaction/interaction.service.ts', resolve)
const { IACService } = load('src/app/services/iac/iac.service.ts', (name) => {
  if (name.includes('interaction.service')) return { InteractionOperationType }
  return resolve(name)
})
const { DeserializedDetailEffects } = load('src/app/pages/deserialized-detail/deserialized-detail.effects.ts', (name) => {
  if (name.includes('interaction.service')) return { InteractionOperationType }
  return resolve(name)
})
function deferred() { let resolve; const promise = new Promise((accept) => { resolve = accept }); return { promise, resolve } }

// Load actual upstream signing and adapter sources. Only Angular registration is stubbed.
let keyPairService
function realSigner() {
  if (keyPairService) return keyPairService
  const directory = path.dirname(require.resolve('@airgap/angular-core/package.json'))
  const cache = new Map()
  function read(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const local = (name) => name === '@angular/core'
      ? new Proxy(angular, { get: (target, key) => target[key] || (() => undefined) })
      : name.startsWith('.') ? read(path.resolve(path.dirname(file), name + '.mjs')) : require(name)
    new Function('require', 'module', 'exports', source)(local, module, module.exports)
    return module.exports
  }
  const { KeyPairService } = read(path.join(directory, 'esm2022/lib/services/key-pair/key-pair.service.mjs'))
  keyPairService = new KeyPairService()
  return keyPairService
}
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const entropy = '00000000000000000000000000000000'
async function fixture(passphrase = 'PUBLIC-REGISTERED-PASSPHRASE') {
  const protocol = new EthereumProtocol()
  const derivationPath = "m/44'/60'/0'/0/0"
  const publicKey = await protocol.getPublicKeyFromMnemonic(mnemonic, derivationPath, passphrase)
  const wallet = new AirGapWallet(protocol, publicKey, false, derivationPath, '', AirGapWalletStatus.ACTIVE, 0)
  const secret = { id: 'public-secret', label: 'Public fixture', fingerprint: 'BASE-FINGERPRINT-MUST-NOT-BE-GROUP-ID', wallets: [wallet] }
  let epoch = 1, opened = true
  const access = {
    isUnlocked: (value) => opened && (!value || value.id === secret.id),
    requireUnlocked(value) { if (!this.isUnlocked(value)) throw Error('Open the Secret first'); return { epoch, wallets: [wallet] } },
    getCurrentSecret() { this.requireUnlocked(); return secret },
    getContextId() { this.requireUnlocked(); return epoch },
    assertContext(value) { this.requireUnlocked(); if (value !== epoch) throw Error('Wallet changed') },
    getWallets(value) { this.requireUnlocked(value); return [wallet] },
    assertWallet(value, owner) { this.requireUnlocked(owner); if (value !== wallet) throw Error('Foreign wallet') },
    getPassphrase(value) { this.requireUnlocked(value); return passphrase },
    getShareGroupId(value) { this.requireUnlocked(value); return 'public-secret:PUBLIC-RANDOM-PROFILE-ID' }
  }
  return { access, wallet, protocol, secret, lock() { epoch++; opened = false } }
}
function effects(setup, signer = realSigner()) {
  const effect = Object.create(DeserializedDetailEffects.prototype)
  Object.assign(effect, { access: setup.access, secretsService: { retrieveEntropyForSecret: async () => entropy }, keyPairService: signer, pageContextId: setup.access.getContextId() })
  return effect
}

test('share exports only current-profile accounts and uses the profile group ID', async () => {
  const setup = await fixture()
  const other = { id: 'another-secret', wallets: [setup.wallet] }
  // A stale full Secret object may still contain old-profile accounts. Its wallets are never enumerated.
  const source = { ...setup.secret, wallets: [{ publicKey: 'PUBLIC-OTHER-PROFILE' }, setup.wallet] }
  const service = new ShareUrlService(setup.access)
  const result = await service.generateShareSecretsURL([source])
  assert.equal(result.length, 1)
  assert.equal(result[0].payload.publicKey, setup.wallet.publicKey)
  assert.equal(result[0].payload.groupId, setup.access.getShareGroupId())
  assert.notEqual(result[0].payload.groupId, setup.secret.fingerprint)
  await assert.rejects(service.generateShareSecretsURL([source, other]), /Open/)
})

test('lock during async account-share generation rejects the old result', async () => {
  const setup = await fixture()
  const pending = deferred()
  setup.wallet.protocol = { getIdentifier: () => pending.promise }
  const result = new ShareUrlService(setup.access).generateShareWalletURL(setup.wallet)
  setup.lock()
  pending.resolve('eth')
  await assert.rejects(result)
})

for (const communicationType of [InteractionCommunicationType.QR, InteractionCommunicationType.DEEPLINK]) {
  test(`${communicationType}: lock while reading interaction settings prevents output`, async () => {
    const setup = await fixture()
    const messages = await new ShareUrlService(setup.access).generateShareWalletURL(setup.wallet)
    const settings = deferred()
    const entered = deferred()
    const output = []
    let reads = 0
    const service = new InteractionService({ routeWithState: (...args) => { output.push(args); return Promise.resolve() } }, {
      sameDeviceDeeplink: (...args) => { output.push(args); return Promise.resolve() }
    }, { get() { if (++reads === 1) return Promise.resolve(storage.InteractionType.QR_CODE); entered.resolve(); return settings.promise } }, setup.access)
    await Promise.resolve()
    const result = service.startInteraction({ operationType: InteractionOperationType.WALLET_SYNC, iacMessage: messages, communicationType })
    await entered.promise
    setup.lock()
    settings.resolve(storage.InteractionType.QR_CODE)
    await assert.rejects(result)
    assert.deepEqual(output, [])
  })
}

test('external signing requests are explicitly refused while no Secret is open', async () => {
  const setup = await fixture(); setup.lock()
  const alerts = []
  const service = Object.create(IACService.prototype)
  Object.assign(service, { access: setup.access, uiEventService: { showTranslatedAlert: async (value) => alerts.push(value) } })
  const result = await service.handleMessageSignRequest({ result: [] }, undefined, () => undefined)
  assert.equal(result, false)
  assert.match(alerts[0].message, /Select a Secret/)
})

for (const passphrase of ['', 'PUBLIC-REGISTERED-PASSPHRASE']) {
  test(`${passphrase ? 'registered Pi' : 'default D maps to empty Pi'}: real message signing uses the current context without passing Pi through an action`, async () => {
    const setup = await fixture(passphrase)
    const effect = effects(setup)
    const message = 'Public current-profile signing fixture'
    const result = await effect.signMessages([{ type: 'unsigned', id: 1, protocol: 'eth', wallet: setup.wallet, data: { message, publicKey: '' } }], 1)
    assert.equal(result.type, actions.messagesSigned.type)
    assert.equal(await setup.protocol.verifyMessage(message, result.messages[0].data.signature, setup.wallet.publicKey), true)
    assert.equal(result.messages[0].data.publicKey, setup.wallet.publicKey)
    assert.equal(JSON.stringify(result).includes('PUBLIC-REGISTERED-PASSPHRASE'), false)
  })
}

test('a known public key from another profile is refused before signing', async () => {
  const setup = await fixture()
  let calls = 0
  const effect = effects(setup, { signWithProtocol: async () => { calls++; throw Error('Must not sign') } })
  const result = await effect.signMessages([{ type: 'unsigned', id: 1, protocol: 'eth', wallet: setup.wallet, data: { message: 'Public wrong-wallet request', publicKey: 'PUBLIC-FOREIGN-KEY' } }], 1)
  assert.equal(result.type, actions.unknownError.type)
  assert.equal(calls, 0)
})

test('empty-public-key messages cannot silently fall back to an active Secret without a selected account', async () => {
  const setup = await fixture()
  let reads = 0
  const effect = effects(setup, { signWithProtocol: async () => { throw Error('Must not sign') } })
  effect.secretsService.retrieveEntropyForSecret = async () => { reads++; return entropy }
  const result = await effect.signMessages([{ type: 'unsigned', id: 1, protocol: 'eth', data: { message: 'Public empty-key request', publicKey: '' } }], 1)
  assert.equal(result.type, actions.unknownError.type)
  assert.equal(reads, 0)
})

test('an in-flight signature is discarded after switching or locking the profile', async () => {
  const setup = await fixture()
  const entered = deferred(), completed = deferred()
  const effect = effects(setup, { signWithProtocol: async () => { entered.resolve(); return completed.promise } })
  const pending = effect.signMessages([{ type: 'unsigned', id: 1, protocol: 'eth', wallet: setup.wallet, data: { message: 'Public delayed signing request', publicKey: setup.wallet.publicKey } }], 1)
  await entered.promise
  setup.lock()
  completed.resolve('PUBLIC-LATE-SIGNATURE')
  const result = await pending
  assert.equal(result.type, actions.operationCancelled.type)
  assert.equal(JSON.stringify(result).includes('PUBLIC-LATE-SIGNATURE'), false)
})

test('a delayed entropy read cannot start signing after access changes', async () => {
  const setup = await fixture()
  const read = deferred(), entered = deferred()
  let calls = 0
  const effect = effects(setup, { signWithProtocol: async () => { calls++; return 'PUBLIC-SIGNATURE' } })
  effect.secretsService.retrieveEntropyForSecret = () => { entered.resolve(); return read.promise }
  const pending = effect.signMessages([{ type: 'unsigned', id: 1, protocol: 'eth', wallet: setup.wallet, data: { message: 'Public delayed read', publicKey: setup.wallet.publicKey } }], 1)
  await entered.promise
  setup.lock(); read.resolve(entropy)
  assert.equal((await pending).type, actions.operationCancelled.type)
  assert.equal(calls, 0)
})

test('derivation path ownership checks require a complete path segment', async () => {
  const setup = await fixture(), effect = effects(setup)
  assert.equal(await effect.getChildDerivationPath('m/44/1', '44/1/0'), '0')
  assert.equal(await effect.getChildDerivationPath('m/44/1', '44/1'), undefined)
  await assert.rejects(effect.getChildDerivationPath('m/44/1', '44/10/0'), /do not match/)
})
