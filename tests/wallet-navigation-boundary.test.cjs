const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const { BehaviorSubject, Subject } = require('rxjs')

class NavigationStart { constructor(id, url) { this.id = id; this.url = url } }
function load(relative, extra = {}) {
  const filename = path.resolve(__dirname, '../src/app', relative)
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, useDefineForClassFields: false }
  }).outputText
  const result = { exports: {} }
  const mocks = {
    '@angular/core': { Injectable: () => (value) => value },
    '@angular/router': { NavigationStart },
    '@capacitor/app': { App: { exitApp() {} } },
    ...extra
  }
  const localRequire = (name) => {
    if (name in mocks) return mocks[name]
    if (name.startsWith('.')) return load(path.relative(path.resolve(__dirname, '../src/app'), path.resolve(path.dirname(filename), name + '.ts')), extra)
    return require(name)
  }
  new Function('require', 'module', 'exports', code)(localRequire, result, result.exports)
  return result.exports
}
const { NavigationService } = load('services/navigation/navigation.service.ts')
const { DefaultSecretAccess } = load('services/navigation/default-secret-access.ts')

function fixture() {
  const subject = new BehaviorSubject(undefined)
  let epoch = 0
  let current
  let currentSecret
  const access = {
    changes$: subject.asObservable(),
    isConfigured: (secret) => secret?.walletAccessVersion === 2,
    isUnlocked: (secret) => !!current && (!secret || secret.id === current.secretId),
    requireUnlocked(secret) { if (!this.isUnlocked(secret)) throw Error('locked'); return current },
    requireDefault(secret) { if (!this.requireUnlocked(secret).isDefault) throw Error('default required') },
    getContextId() { return this.requireUnlocked().epoch },
    getOperationId() { return epoch },
    getCurrentSecret() { return currentSecret },
    getWallets() { return current?.wallets.slice() ?? [] },
    assertContext(value) { if (!current || value !== epoch) throw Error('stale context') },
    assertWallet(wallet) { if (!this.requireUnlocked().wallets.includes(wallet)) throw Error('foreign wallet') },
    lock() { epoch++; current = undefined; currentSecret = undefined; subject.next(undefined) },
    open(secret, isDefault = true, wallets = []) {
      this.lock(); currentSecret = secret; current = { secretId: secret.id, profileId: 'profile-' + epoch, epoch, isDefault, wallets }; subject.next(current)
    },
    publishCurrent() { subject.next(current) }
  }
  const router = {
    url: '/tabs/tab-secrets', events: new Subject(),
    async navigateByUrl(url) { this.events.next(new NavigationStart(1, url)); this.url = url; return true }
  }
  const rootCalls = []
  const navCtrl = { async navigateRoot(url, options) { rootCalls.push({ url, options }); return router.navigateByUrl(url) } }
  const navigation = new NavigationService(router, { back() {} }, navCtrl, access)
  return { access, router, navigation, rootCalls, navCtrl }
}
const secret = { id: 'saved-secret', walletAccessVersion: 2 }
const draft = () => ({ id: 'fresh-secret', secretHex: '00000000000000000000000000000000' })

test('URLs and missing state never authorize protected pages', async () => {
  const { navigation, access } = fixture()
  for (const route of ['/accounts-list', '/secret-edit', '/bip85-show', '/deserialized-detail', '/transaction-signed', '/tabs/tab-scan', '/bitcoin-multisig']) {
    assert.equal(navigation.canActivate(route), false, route)
  }
  access.open(secret)
  assert.equal(navigation.canActivate('/tabs/tab-scan'), true)
  await navigation.route('/account-add')
  assert.equal(navigation.canActivate('/account-add'), false)
  assert.equal(navigation.canActivate('/secret-show'), false)
})

test('fresh generation/import flow remains available without a wallet context', async () => {
  for (const source of ['/secret-generate', '/secret-generate-dice', '/secret-generate-coin-flip', '/secret-import', '/social-recovery-import']) {
    const { router, navigation } = fixture()
    router.url = source
    const value = draft()
    await navigation.routeWithState('/secret-rules', { secret: value })
    assert.equal(navigation.canActivate('/secret-rules'), true)
    await navigation.routeWithState('/secret-show', { secret: value })
    assert.equal(navigation.canActivate('/secret-show'), true)
    await navigation.routeWithState('/secret-validate', { secret: value })
    await navigation.routeWithState('/secret-add', { secret: value })
    assert.equal(navigation.canActivate('/secret-add'), true)
    await assert.rejects(navigation.routeWithState('/secret-show', { secret: draft() }), /generation or import/)
  }
})

test('legacy saved unconfigured objects cannot acquire draft authorization', async () => {
  const { router, navigation } = fixture()
  const value = draft()
  navigation.setPersistedSecretIds([value.id])
  router.url = '/secret-import'
  await assert.rejects(navigation.routeWithState('/secret-show', { secret: value }), /generation or import/)
  router.url = '/tabs/tab-secrets'
  await assert.rejects(navigation.routeWithState('/secret-add', { secret: draft() }), /generation or import/)
})

test('root phrase copies and BIP85 child drafts require default branch, including late transitions', async () => {
  const { router, navigation, access } = fixture()
  access.open(secret, false)
  router.url = '/secret-edit'
  await assert.rejects(navigation.routeWithState('/secret-show', { secret: draft() }), /default required/)
  router.url = '/bip85-show'
  await assert.rejects(navigation.routeWithState('/secret-add', { secret: draft() }), /default required/)
  access.open(secret, true)
  router.url = '/secret-edit'
  const value = draft()
  await navigation.routeWithState('/secret-show', { secret: value })
  assert.equal(navigation.canActivate('/secret-show'), true)
  navigation.assertSecretDisplay(value)
  access.lock()
  assert.throws(() => navigation.assertSecretDisplay(value))
  assert.equal(navigation.canActivate('/secret-show'), false)
})

test('context change rejects old accounts and back navigation instead of reviving state', async () => {
  const { navigation, access } = fixture()
  const wallet = { publicKey: 'public-test-key' }
  access.open(secret, true, [wallet])
  await navigation.routeWithState('/account-address', { secret, wallet })
  assert.equal(navigation.canActivate('/account-address'), true)
  access.publishCurrent()
  assert.equal(navigation.canActivate('/account-address'), true, 'same-epoch account refresh keeps the grant')
  access.lock()
  access.open(secret, false, [{ publicKey: 'different-public-key' }])
  assert.equal(navigation.canActivate('/account-address'), false)
  await navigation.routeWithState('/account-address', { secret, wallet })
  assert.equal(navigation.canActivate('/account-address'), false, 'old profile object is rejected')
  assert.equal(navigation.canActivate('/secret-edit'), false)
})

test('same-context forward and back navigation restores each visited route state', async () => {
  const { navigation, access } = fixture()
  const wallet = { publicKey: 'public-test-key' }
  access.open(secret, true, [wallet])
  await navigation.routeWithState('/accounts-list', { secret, onlyList: true })
  await navigation.routeWithState('/account-address', { secret, wallet })
  assert.equal(navigation.canActivate('/accounts-list'), true)
  assert.equal(navigation.getState().onlyList, true)
  assert.equal(navigation.getState().wallet, undefined)
  await navigation.routeWithState('/secret-edit', { secret, onlyManagement: true })
  assert.equal(navigation.canActivate('/accounts-list'), true)
  assert.equal(navigation.getState().onlyManagement, undefined)
  assert.equal(navigation.canActivate('/account-address'), true)
  assert.equal(navigation.getState().wallet, wallet)
  access.lock()
  access.open(secret, true, [wallet])
  for (const route of ['/accounts-list', '/account-address', '/secret-edit']) {
    assert.equal(navigation.canActivate(route), false, 'old route remains revoked: ' + route)
  }
})

test('captured default grants and cleanup stay revoked after reopening the same Secret', async () => {
  const { navigation, access } = fixture()
  access.open(secret)
  let displayedMnemonic = 'public test mnemonic'
  const grant = new DefaultSecretAccess(navigation, secret, () => { displayedMnemonic = '' })
  grant.assert()
  access.lock()
  assert.equal(displayedMnemonic, '')
  access.open(secret)
  assert.throws(() => grant.assert(), /stale context/)
  grant.dispose()
})

test('return to total Secrets list clears state and uses Ionic root navigation', async () => {
  const { navigation, access, rootCalls } = fixture()
  access.open(secret)
  await navigation.routeWithState('/secret-edit', { secret })
  let cleaned = false
  navigation.registerSensitiveCleanup(() => { cleaned = true })
  await navigation.routeToSecretsTab()
  assert.equal(access.isUnlocked(), false)
  assert.deepEqual(navigation.getState(), {})
  assert.equal(cleaned, true)
  assert.equal(rootCalls.at(-1).url, '/tabs/tab-secrets')
  assert.equal(navigation.canActivate('/secret-edit'), false)
})

test('direct Router navigation to Secrets list also revokes the wallet', async () => {
  const { navigation, access, router } = fixture()
  access.open(secret)
  await navigation.routeWithState('/accounts-list', { secret })
  await router.navigateByUrl('/tabs/tab-secrets')
  assert.equal(access.isUnlocked(), false)
  assert.deepEqual(navigation.getState(), {})
})

function appComponent() {
  const filename = path.resolve(__dirname, '../src/app/app.component.ts')
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, useDefineForClassFields: false }
  }).outputText
  const module = { exports: {} }
  const resolve = (name) => {
    if (name === '@angular/core') return { Component: () => (value) => value, Inject: () => () => {} }
    if (name === 'swiper/element/bundle') return { register() {} }
    if (name.includes('error-handler.service')) return { ErrorCategory: {}, handleErrorLocal: () => () => {} }
    return {}
  }
  new Function('require', 'module', 'exports', code)(resolve, module, module.exports)
  return module.exports.AppComponent
}
const AppComponent = appComponent()

for (const os of ['ios', 'android']) {
  test(`${os}: native background locks synchronously, authentication-only lifecycle events do not`, async () => {
    const { navigation, access } = fixture()
    access.open(secret)
    const callbacks = new Map()
    const app = Object.create(AppComponent.prototype)
    Object.assign(app, {
      listenerHandles: [],
      platform: { ready: async () => {}, is: (name) => ['hybrid', os].includes(name), backButton: { subscribeWithPriority() {} } },
      app: { async addListener(name, callback) { callbacks.set(name, callback); return { remove: async () => {} } } },
      walletAccess: access,
      navigationService: navigation,
      modalController: { getTop: async () => undefined },
      ngZone: { run: (callback) => callback() }
    })
    await app.ngAfterViewInit()
    if (os === 'ios') {
      assert.equal(callbacks.has('appStateChange'), false, 'iOS willResignActive is not the locking event')
      assert.equal(access.isUnlocked(), true)
      callbacks.get('pause')()
    } else {
      assert.equal(callbacks.has('pause'), false, 'Android onPause is not the locking event')
      callbacks.get('appStateChange')({ isActive: true })
      assert.equal(access.isUnlocked(), true)
      callbacks.get('appStateChange')({ isActive: false })
    }
    assert.equal(access.isUnlocked(), false, 'revoke before modal/navigation awaits')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(navigation.getState(), {})
  })
}

test('late background modal lookup cannot dismiss a new modal or lock a reopened wallet', async () => {
  const { navigation, access, rootCalls } = fixture()
  access.open(secret)
  const lookup = deferred()
  let dismissals = 0
  const app = Object.create(AppComponent.prototype)
  Object.assign(app, {
    walletAccess: access,
    navigationService: navigation,
    modalController: { getTop: () => lookup.promise },
    ngZone: { run: (callback) => callback() }
  })
  app.closeWalletForBackground()
  assert.equal(access.isUnlocked(), false)
  access.open(secret)
  lookup.resolve({ async dismiss() { dismissals++ } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(access.isUnlocked(), true)
  assert.equal(dismissals, 0)
  assert.deepEqual(rootCalls, [])
})

test('late background modal dismissal cannot resume cleanup in a reopened wallet', async () => {
  const { navigation, access, rootCalls } = fixture()
  access.open(secret)
  const dismissing = deferred(), dismissed = deferred()
  let lookups = 0
  const app = Object.create(AppComponent.prototype)
  Object.assign(app, {
    walletAccess: access,
    navigationService: navigation,
    modalController: { async getTop() {
      lookups++
      return { async dismiss() { dismissing.resolve(); await dismissed.promise } }
    } },
    ngZone: { run: (callback) => callback() }
  })
  app.closeWalletForBackground()
  await dismissing.promise
  access.open(secret)
  dismissed.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(access.isUnlocked(), true)
  assert.equal(lookups, 1, 'no second lookup that could target the new modal')
  assert.deepEqual(rootCalls, [])
})

function displayPage(relative) {
  const filename = path.resolve(__dirname, '../src/app/pages', relative)
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, useDefineForClassFields: false }
  }).outputText
  const module = { exports: {} }
  const resolve = (name) => {
    if (name === '@angular/core') return { Component: () => (value) => value, ViewChild: () => () => {} }
    if (name.includes('error-handler.service')) return { ErrorCategory: {}, handleErrorLocal: () => () => {} }
    if (name.endsWith('/models/secret')) return { MnemonicSecret: class {
      constructor(secretHex, label) { this.secretHex = secretHex; this.label = label; this.fingerprint = '00000000' }
    } }
    if (name.endsWith('storage.service')) return { VaultStorageKey: {}, AdvancedModeType: {} }
    if (name === 'rxjs' || name === 'rxjs/operators') return require(name)
    return {}
  }
  new Function('require', 'module', 'exports', code)(resolve, module, module.exports)
  return Object.values(module.exports)[0]
}

for (const trigger of ['back button', 'context revocation', 'root navigation request']) {
  test(`return after an account address: ${trigger} closes the wallet without recursive root navigation`, async () => {
    const setup = fixture()
    const { access, navigation, router, rootCalls } = setup
    const wallet = { protocol: { getName: async () => 'Bitcoin' } }
    access.open(secret, true, [wallet])
    await navigation.routeWithState('/accounts-list', { secret })
    const Page = displayPage('accounts-list/accounts-list.page.ts')
    const page = new Page({ is: () => false }, navigation, {}, {}, {}, {}, {}, access)
    page.ionViewWillEnter()
    page.ionViewDidLeave()
    await navigation.routeWithState('/account-address', { secret, wallet })
    assert.equal(navigation.canActivate('/accounts-list'), true)
    await router.navigateByUrl('/accounts-list')
    page.ionViewWillEnter()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(page.canView, true)
    assert.equal(page.wallets$.value.length, 1)

    // Bound emissions to expose the feedback loop without overflowing the test
    // process. A correct return must not need this limit.
    let lockCalls = 0
    const lock = access.lock.bind(access)
    access.lock = () => { if (++lockCalls <= 8) lock() }
    if (trigger === 'back button') page.navigateToSecretsTab()
    else if (trigger === 'context revocation') access.lock()
    else navigation.routeToSecretsTab()
    assert.equal(page.canView, false, 'revoke the visible account before awaiting navigation')
    assert.equal(page.wallets$.value.length, 0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(lockCalls < 8, `lock notification feedback loop: ${lockCalls} calls`)
    assert.equal(rootCalls.length, 1, 'one return must result in one root navigation')
    assert.equal(router.url, '/tabs/tab-secrets')
    assert.equal(navigation.canActivate('/account-address'), false)
    assert.equal(navigation.canActivate('/accounts-list'), false)
    page.ngOnDestroy()
  })
}

test('concurrent returns share the pending root navigation and can retry after failure', async () => {
  const { navigation, access, navCtrl } = fixture()
  access.open(secret)
  const result = deferred()
  let calls = 0
  navCtrl.navigateRoot = () => { calls++; return result.promise }
  const first = navigation.routeToSecretsTab()
  const second = navigation.routeToSecretsTab()
  assert.equal(access.isUnlocked(), false)
  assert.equal(first, second)
  assert.equal(calls, 1)
  result.resolve(false)
  assert.equal(await first, false)
  navCtrl.navigateRoot = async () => { calls++; throw new Error('public navigation fixture') }
  await assert.rejects(navigation.routeToSecretsTab(), /public navigation fixture/)
  navCtrl.navigateRoot = async () => { calls++; return true }
  assert.equal(await navigation.routeToSecretsTab(), true)
  assert.equal(calls, 3)
})

test('a coalesced return still revokes a newly opened wallet and an in-flight unlock', async () => {
  const { navigation, access, navCtrl } = fixture()
  access.open(secret)
  const result = deferred()
  let calls = 0
  navCtrl.navigateRoot = () => { calls++; return result.promise }
  const returning = navigation.routeToSecretsTab()
  access.open(secret)
  assert.equal(access.isUnlocked(), true)
  assert.equal(navigation.routeToSecretsTab(), returning)
  assert.equal(access.isUnlocked(), false, 'a pending navigation must not bypass a new close request')
  // unlock() advances the epoch before awaiting native storage, while no
  // context exists yet. A subsequent close must invalidate that operation too.
  access.lock()
  const unlocking = access.getOperationId()
  navigation.routeToSecretsTab()
  assert.ok(access.getOperationId() > unlocking)
  assert.equal(calls, 1)
  result.resolve(true)
  assert.equal(await returning, true)
  navCtrl.navigateRoot = async () => { calls++; return true }
  assert.equal(await navigation.routeToSecretsTab(), true)
  assert.equal(calls, 2, 'a completed return must not suppress a later return')
})

test('a synchronously failing root navigation releases the pending return for retry', async () => {
  const { navigation, navCtrl } = fixture()
  navCtrl.navigateRoot = () => { throw new Error('public synchronous fixture') }
  await assert.rejects(navigation.routeToSecretsTab(), /public synchronous fixture/)
  navCtrl.navigateRoot = async () => true
  assert.equal(await navigation.routeToSecretsTab(), true)
})

test('display cache cleanup clears its own copy without deleting the draft that SecretAdd is saving', async () => {
  const Show = displayPage('secret-show/secret-show.page.ts')
  const Validate = displayPage('secret-validate/secret-validate.page.ts')
  const { navigation, access, router } = fixture()
  router.url = '/secret-generate'
  const value = draft()
  await navigation.routeWithState('/secret-show', { secret: value })
  const shown = new Show({}, navigation, {}, {}, {}, { subscribe: () => new BehaviorSubject(undefined) })
  await navigation.routeWithState('/secret-validate', { secret: value })
  const validated = new Validate({}, navigation)
  validated.verify = { secret: 'public mnemonic', splittedSecret: ['public'], currentWords: ['public'], promptedWords: ['public'] }
  await navigation.routeWithState('/secret-add', { secret: value })
  // createSecret starts by revoking the old context. The shared source must remain
  // usable by the authorized create operation until the secure write flushes it.
  access.lock()
  assert.equal(value.secretHex, '00000000000000000000000000000000')
  assert.equal(shown.secret.secretHex, '')
  assert.equal(validated.secret.secretHex, '')
  assert.deepEqual(validated.verify.currentWords, [])
  assert.deepEqual(validated.verify.splittedSecret, [])
  assert.throws(() => shown.changeBlur())
  assert.throws(() => validated.goToSecretAddPage())
})

test('lifehash completion cannot republish an old root display after revocation', async () => {
  const Show = displayPage('secret-show/secret-show.page.ts')
  const { navigation, access, router } = fixture()
  router.url = '/secret-generate'
  await navigation.routeWithState('/secret-show', { secret: draft() })
  let release
  const pendingLifehash = new Promise((resolve) => { release = resolve })
  const page = new Show({ enableScreenshotProtection() {} }, navigation, {}, {}, { generateLifehash: () => pendingLifehash },
    { subscribe: () => new BehaviorSubject(undefined) })
  const pending = page.ionViewDidEnter()
  access.lock()
  release('PUBLIC-LATE-LIFEHASH')
  await assert.rejects(pending)
  assert.equal(page.lifehashData, undefined)
  assert.equal(page.secret.secretHex, '')
})

test('BIP85 reads entropy through the actual single-item SecretsService and preserves D authorization', async () => {
  const sourceLoad = require('./helpers/source-loader.cjs')({
    [path.resolve(__dirname, '../src/app/services/storage/storage.service')]: { VaultStorageKey: { AIRGAP_SECRET_LIST: 'secrets' } },
    [path.resolve(__dirname, '../src/app/services/error-handler/error-handler.service')]: { ErrorCategory: {}, handleErrorLocal: () => () => {} }
  })
  const { WalletAccessService } = sourceLoad('src/app/services/wallet-access/wallet-access.service.ts')
  const { SecretsService } = sourceLoad('src/app/services/secrets/secrets.service.ts')
  const { MnemonicSecret } = sourceLoad('src/app/models/secret.ts')
  const { Bip85ShowPage } = sourceLoad('src/app/pages/bip85-show/bip85-show.page.ts')
  const { BIP32Factory } = require('@airgap/coinlib-core/dependencies/src/bip32-5.0.1/src/index')
  const ecc = require('@airgap/coinlib-core/dependencies/src/@bitcoinerlab/secp256k1-1.2.0/src/index')
  const items = new Map()
  const secure = { async get(alias) { return {
    async getItem(key) { return { value: items.get(alias + ':' + key) } },
    async setItem(key, value) { items.set(alias + ':' + key, value) }
  } } }
  const access = new WalletAccessService(secure, {})
  const service = new SecretsService(secure, { async get() { return [] }, async set() {} }, {}, {}, {}, {}, {}, access)
  const secret = new MnemonicSecret('00000000000000000000000000000000', 'Public BIP85 fixture')
  await service.createSecret(secret, 'PUBLIC-DEFAULT-GATE')
  const location = access.getStorageLocation(secret)
  const item = JSON.parse(items.get(location.alias + ':' + location.key))
  assert.equal(item.format, 'airgap-wallet-access-v2')
  assert.equal(item.entropy, undefined)
  const epoch = access.getContextId()
  const page = Object.create(Bip85ShowPage.prototype)
  Object.assign(page, {
    access: { assert() { access.assertContext(epoch); access.requireDefault(secret) } },
    secretsService: service,
    bip39Passphrase: '',
    bip32: BIP32Factory(ecc),
    lifehashService: { async generateLifehash() { return 'PUBLIC-CHILD-LIFEHASH' } }
  })
  await page.generateChildMnemonic(secret, 12, 0)
  assert.equal(require('bip39').validateMnemonic(page.childMnemonic), true)
  assert.equal(page.childMnemonic.split(' ').length, 12)
  assert.equal(page.lifehashData, 'PUBLIC-CHILD-LIFEHASH')
  access.lock()
  await assert.rejects(page.generateChildMnemonic(secret, 12, 0), /changed/)
})

function addressExplorer() {
  const sourceLoad = require('./helpers/source-loader.cjs')({
    [path.resolve(__dirname, '../src/app/services/error-handler/error-handler.service')]: { ErrorCategory: {}, handleErrorLocal: () => () => {} }
  })
  return sourceLoad('src/app/pages/address-explorer/address-explorer.page.ts').AddressExplorerPage
}
function deferred() {
  let resolve
  const promise = new Promise((accept) => { resolve = accept })
  return { promise, resolve }
}
async function explorerFixture(derive) {
  const { BIP32Factory } = require('@airgap/coinlib-core/dependencies/src/bip32-5.0.1/src/index')
  const ecc = require('@airgap/coinlib-core/dependencies/src/@bitcoinerlab/secp256k1-1.2.0/src/index')
  const setup = fixture()
  const calls = []
  const wallet = {
    publicKey: BIP32Factory(ecc).fromSeed(new Uint8Array(32)).neutered().toBase58(),
    derivationPath: "m/44'/0'/0'",
    protocol: {
      getIdentifier: async () => 'btc',
      async getAddressFromExtendedPublicKey(xpub, visibility, index) {
        calls.push({ xpub, visibility, index })
        return derive ? derive(xpub, visibility, index) : { address: `PUBLIC:${visibility}:${index}` }
      }
    }
  }
  setup.access.open(secret, false, [wallet])
  await setup.navigation.routeWithState('/address-explorer', { wallet })
  const Page = addressExplorer()
  const page = new Page(setup.navigation, setup.access)
  return { ...setup, wallet, page, calls }
}

test('address explorer clears all cached account data on lock and discards an awaited address', async () => {
  const started = deferred(), result = deferred()
  const setup = await explorerFixture(async () => { started.resolve(); return result.promise })
  const entering = setup.page.ionViewWillEnter()
  await started.promise
  assert.equal(setup.page.isCurrent, true)
  setup.access.lock()
  assert.equal(setup.page.wallet, undefined)
  assert.equal(setup.page.xpub, '')
  assert.deepEqual(setup.page.addresses, [])
  assert.equal(setup.page.isCurrent, false)
  result.resolve({ address: 'PUBLIC-LATE-ADDRESS' })
  await entering
  assert.deepEqual(setup.page.addresses, [])
  assert.equal(setup.calls.length, 1, 'no further derivations start after revocation')
  setup.access.open(secret, false, [setup.wallet])
  assert.equal(setup.navigation.canActivate('/address-explorer'), false, 'old history grant stays revoked')
  await setup.page.ionViewWillEnter()
  assert.equal(setup.page.wallet, undefined)
})

test('address explorer paginates once per batch and reloads on same-context return', async () => {
  const setup = await explorerFixture()
  await setup.page.ionViewWillEnter()
  assert.equal(setup.page.addresses.length, 20)
  await Promise.all([setup.page.addAddresses(), setup.page.addAddresses()])
  assert.equal(setup.page.addresses.length, 40)
  assert.equal(setup.calls.length, 40, 'concurrent scroll events share the batch')
  assert.equal(new Set(setup.page.addresses.map((row) => row.address)).size, 40)
  setup.page.ionViewWillLeave()
  assert.equal(setup.page.isCurrent, false)
  assert.equal(setup.page.wallet, undefined)
  assert.equal(setup.page.xpub, '')
  assert.equal(setup.navigation.canActivate('/address-explorer'), true)
  await setup.page.ionViewWillEnter()
  assert.equal(setup.page.isCurrent, true)
  assert.equal(setup.page.wallet, setup.wallet)
  assert.equal(setup.page.addresses.length, 20)
  setup.page.ngOnDestroy()
  assert.equal(setup.page.wallet, undefined)
})

test('changing address tab discards the prior tab pending batch within the same epoch', async () => {
  const started = deferred(), result = deferred()
  const setup = await explorerFixture(async (_xpub, visibility, index) => {
    if (visibility === 0 && index === 20) { started.resolve(); return result.promise }
    return { address: `PUBLIC:${visibility}:${index}` }
  })
  await setup.page.ionViewWillEnter()
  const oldBatch = setup.page.addAddresses()
  await started.promise
  await setup.page.segmentChanged({ detail: { value: 'internal' } })
  result.resolve({ address: 'PUBLIC-OLD-TAB-LATE' })
  await oldBatch
  assert.equal(setup.page.addresses.length, 20)
  assert.equal(setup.page.selectedTab, 'internal')
  assert.ok(setup.page.addresses.every((row) => row.address.startsWith('PUBLIC:1:')))
  assert.equal(setup.page.loading, false)
})
