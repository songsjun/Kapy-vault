const test = require('node:test')
const assert = require('node:assert/strict')
const { BehaviorSubject } = require('rxjs')
const sourceLoader = require('./helpers/source-loader.cjs')
const fixtures = require('./helpers/multisig-fixtures.cjs')

const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function accessFixture() {
  const changes$ = new BehaviorSubject({ epoch: 7 })
  let epoch = 7
  const secret = { id: 'PUBLIC-FIXTURE' }
  return {
    changes$, getContextId: () => epoch, getCurrentSecret: () => secret,
    assertContext(value) { if (value !== epoch || !changes$.value) throw Error('Wallet access changed') },
    getPassphrase: () => '', readEntropy: async () => '0'.repeat(32),
    lock() { epoch++; changes$.next(undefined) }
  }
}

function serviceFixture() {
  const access = accessFixture()
  const calls = []
  const core = {
    async deriveMultisigCosigner(mnemonic, passphrase, options) { calls.push({ mnemonic, passphrase, options }); return { xpub: 'PUBLIC-XPUB' } },
    async signMultisigPsbt(hex, mnemonic, passphrase, network) { calls.push({ hex, mnemonic, passphrase, network }); return { psbtHex: 'PUBLIC-RESULT' } }
  }
  const load = sourceLoader({ './bitcoin-multisig': core })
  const { BitcoinMultisigService } = load('src/app/services/bitcoin-multisig/bitcoin-multisig.service.ts')
  return { access, calls, core, service: new BitcoinMultisigService(access) }
}

test('multisig service uses the native open profile passphrase, including the default empty BIP39 passphrase', async () => {
  const f = serviceFixture()
  await f.service.exportCosigner(7, 'mainnet', 'p2wsh', 0)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].passphrase, '')
  assert.equal(f.calls[0].mnemonic, 'abandon '.repeat(11) + 'about')
  f.access.getPassphrase = () => 'PUBLIC-REGISTERED-PROFILE'
  await f.service.sign(7, '70736274ff', 'testnet')
  assert.equal(f.calls[1].passphrase, 'PUBLIC-REGISTERED-PROFILE')
})

for (const operation of ['export', 'sign']) {
  test(`${operation}: a delayed native entropy read cannot begin crypto after the profile changes`, async () => {
    const f = serviceFixture()
    const pending = deferred()
    f.access.readEntropy = () => pending.promise
    const work = operation === 'export' ? f.service.exportCosigner(7, 'mainnet', 'p2wsh', 0) : f.service.sign(7, '70736274ff', 'mainnet')
    f.access.lock()
    pending.resolve('0'.repeat(32))
    await assert.rejects(work, /access changed/)
    assert.equal(f.calls.length, 0)
  })

  test(`${operation}: a late crypto result is not published into a new profile`, async () => {
    const f = serviceFixture()
    const pending = deferred()
    const entered = deferred()
    f.core[operation === 'export' ? 'deriveMultisigCosigner' : 'signMultisigPsbt'] = () => { entered.resolve(); return pending.promise }
    const work = operation === 'export' ? f.service.exportCosigner(7, 'mainnet', 'p2wsh', 0) : f.service.sign(7, '70736274ff', 'mainnet')
    await entered.promise
    f.access.lock()
    pending.resolve({ psbtHex: 'PUBLIC-LATE-RESULT' })
    await assert.rejects(work, /access changed/)
  })
}

function pageFixture() {
  const access = accessFixture()
  const pending = deferred()
  const cleanups = new Set()
  const navigation = {
    getState: () => ({ contextId: 7 }),
    registerSensitiveCleanup(fn) { cleanups.add(fn); return () => cleanups.delete(fn) },
    routeWithState: async () => true
  }
  const calls = { encoders: 0, scans: 0 }
  class ScanBasePage {
    constructor() { this.isBrowser = true; this.isMobile = false }
    stopScan() { calls.scans-- }
    startScan() { calls.scans++ }
    ionViewDidEnter() {}
    async ionViewWillEnter() {}
  }
  const qr = {
    multisigCosignerEncoder() { calls.encoders++; return { fragmentsLength: 1, nextPart: () => 'UR:CRYPTO-ACCOUNT/PUBLIC' } },
    multisigPsbtEncoder() { calls.encoders++; return { fragmentsLength: 1, nextPart: () => 'UR:CRYPTO-PSBT/PUBLIC' } },
    MultisigPsbtQrDecoder: class {}
  }
  const load = sourceLoader({
    '@airgap/angular-core': {}, '@ionic/angular': {}, '@zxing/ngx-scanner': {},
    '../../capacitor-plugins/injection-tokens': { SECURITY_UTILS_PLUGIN: 'PUBLIC-TOKEN' },
    '../scan-base/scan-base': { ScanBasePage },
    '../../services/bitcoin-multisig/bitcoin-multisig-qr': qr,
    '../../services/bitcoin-multisig/bitcoin-multisig.service': {},
    '../../services/navigation/navigation.service': {},
    '../../services/wallet-access/wallet-access.service': {}
  })
  const { BitcoinMultisigPage } = load('src/app/pages/bitcoin-multisig/bitcoin-multisig.page.ts')
  const page = new BitcoinMultisigPage({}, {}, {}, {}, access,
    { exportCosigner: () => pending.promise, sign: () => pending.promise }, navigation, { run: (fn) => fn() })
  return { page, access, pending, calls, cleanups }
}

test('leaving the multisig page discards a pending public key export and creates no QR timer', async () => {
  const f = pageFixture()
  await f.page.ionViewWillEnter()
  const work = f.page.exportCosigner()
  f.page.ionViewWillLeave()
  f.pending.resolve({ xpub: 'PUBLIC-XPUB' })
  await work
  assert.equal(f.calls.encoders, 0)
  assert.equal(f.page.qrData, '')
  assert.equal(f.page.cosigner, undefined)
  assert.equal(f.page.busy, false)
  f.page.ngOnDestroy()
})

test('locking during multisig signing clears review and prevents a late signed QR', async () => {
  const f = pageFixture()
  await f.page.ionViewWillEnter()
  f.page.stage = 'review'
  f.page.review = { network: 'mainnet' }
  f.page.requestPsbt = 'PUBLIC-PSBT'
  const work = f.page.sign()
  f.access.lock()
  f.pending.resolve({ psbtHex: 'PUBLIC-LATE-PSBT', addedSignatures: 1, alreadySignedInputs: 0 })
  await work
  assert.equal(f.calls.encoders, 0)
  assert.equal(f.page.review, undefined)
  assert.equal(f.page.requestPsbt, undefined)
  assert.equal(f.page.qrData, '')
  f.page.ngOnDestroy()
})

test('a newer page operation invalidates an older export without republishing it', async () => {
  const f = pageFixture()
  await f.page.ionViewWillEnter()
  const work = f.page.exportCosigner()
  f.page.reset()
  f.pending.resolve({ xpub: 'PUBLIC-OLD-XPUB' })
  await work
  assert.equal(f.calls.encoders, 0)
  assert.equal(f.page.stage, 'setup')
  f.page.ngOnDestroy()
})

test('signing an already signed PSBT returns its QR with an explicit zero-new-signatures count', async () => {
  const f = pageFixture()
  await f.page.ionViewWillEnter()
  f.page.stage = 'review'
  f.page.review = { network: 'mainnet' }
  f.page.requestPsbt = 'PUBLIC-PSBT'
  const work = f.page.sign()
  f.pending.resolve({ psbtHex: 'PUBLIC-SIGNED-PSBT', addedSignatures: 0, alreadySignedInputs: 1 })
  await work
  assert.equal(f.page.stage, 'signed')
  assert.equal(f.page.addedSignatures, 0)
  assert.equal(f.page.alreadySignedInputs, 1)
  assert.equal(f.page.requestPsbt, undefined)
  f.page.ngOnDestroy()
  assert.equal(f.page.qrData, '')
})

test('Done returns to the authorized account list with its Secret reference and preserves the open profile', async () => {
  const f = pageFixture()
  await f.page.ionViewWillEnter()
  let target
  f.page.navigation.routeWithState = async (route, state) => { target = { route, state }; return true }
  await f.page.done()
  assert.equal(target.route, '/accounts-list')
  assert.equal(target.state.secret, f.access.getCurrentSecret())
  assert.equal(target.state.contextId, 7)
  assert.doesNotThrow(() => f.access.assertContext(7))
  assert.equal(f.page.qrData, '')
  f.page.ngOnDestroy()
})

function iacFixture() {
  const access = accessFixture()
  access.isUnlocked = () => true
  const routes = []
  const load = sourceLoader({
    '@airgap/angular-core': { BaseIACService: class { constructor() { this.serializerMessageHandlers = {} } } },
    '@ionic/angular': {},
    '../error-handler/error-handler.service': { ErrorCategory: {}, handleErrorLocal: () => () => {} },
    '../interaction/interaction.service': { InteractionOperationType: {} },
    'src/app/pages/select-account/select-account.page': { SelectAccountPage: class {} }
  })
  const { IACService } = load('src/app/services/iac/iac.service.ts')
  const service = new IACService({}, {}, {}, {}, {}, {
    async routeWithState(route, state) { routes.push({ route, state }); return true }
  }, { isReady: () => Promise.resolve() }, {}, {}, {}, {}, access)
  return { service, routes }
}

for (const scriptType of ['p2sh', 'p2sh-p2wsh', 'p2wsh']) {
  test(`the existing QR IAC entry routes ${scriptType} to the isolated multisig flow`, async () => {
    const f = iacFixture()
    const psbt = fixtures.fixture({ scriptType }).psbt.toHex()
    const request = { protocol: scriptType === 'p2sh' ? 'btc' : 'btc_segwit', payload: { transaction: { psbt } } }
    assert.equal(await f.service.handleUnsignedTransactions({ result: [request] }, undefined, () => {}), true)
    assert.equal(f.routes[0].route, '/bitcoin-multisig')
    assert.equal(f.routes[0].state.psbtHex, psbt)
    assert.equal(f.routes[0].state.contextId, 7)
  })
}

test('an ordinary Bitcoin single-signature IAC request keeps its existing review route', async () => {
  const f = iacFixture()
  let originalMatcherCalls = 0
  f.service.findMatchingWallet = async (request) => {
    originalMatcherCalls++
    return { wallet: { publicKey: 'PUBLIC-KEY' }, signTransactionRequest: request }
  }
  const request = { protocol: 'btc_segwit', payload: { transaction: { psbt: '70736274ff' } } }
  assert.equal(await f.service.handleUnsignedTransactions({ result: [request] }, undefined, () => {}), true)
  assert.equal(originalMatcherCalls, 1)
  assert.equal(f.routes[0].route, 'deserialized-detail')
})
