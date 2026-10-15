const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const { BehaviorSubject, of } = require('rxjs')
const root = path.resolve(__dirname, '..')
const decorator = () => () => undefined
function load(relative, symbol) {
  const source = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, experimentalDecorators: true }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)((name) => {
    if (name === '@angular/core') return { Component: decorator, ViewChild: decorator }
    if (name === '@airgap/angular-core') return { QRType: { V3: 3, BC_UR: 4, METAMASK: 5 } }
    if (name === '@airgap/coinlib-core') return { MainProtocolSymbols: { ETH: 'eth' } }
    if (name === '@ionic/angular') return { IonModal: class {} }
    if (name === 'rxjs' || name === 'rxjs/operators') return require(name)
    if (name.includes('storage/storage.service')) return { AdvancedModeType: { ADVANCED: 'advanced' }, VaultStorageKey: {} }
    if (name.includes('error-handler')) return { ErrorCategory: {}, handleErrorLocal: () => () => undefined }
    if (name.endsWith('/migration')) return { isWalletMigrated: (wallet) => Boolean(wallet.masterFingerprint) }
    if (name.includes('interaction.service')) return { InteractionOperationType: { WALLET_SYNC: 'walletSync' } }
    return {}
  }, module, module.exports)
  return module.exports[symbol]
}
const AccountAddressPage = load('src/app/pages/account-address/account-address.page.ts', 'AccountAddressPage')
const AccountEditPopoverComponent = load('src/app/pages/account-address/account-edit-popover/account-edit-popover.component.ts', 'AccountEditPopoverComponent')
const tick = () => new Promise((resolve) => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise((accept) => { resolve = accept }); return { promise, resolve } }
function overlay() {
  const state = { presented: 0, dismissed: 0 }
  return { state, async present() { state.presented++ }, async dismiss() { state.dismissed++; return true } }
}
function fixture() {
  const cleanups = new Set(), copies = [], interactions = []
  const secret = { id: 'PUBLIC-SECRET', label: 'Public fixture' }
  const wallet = {
    publicKey: 'PUBLIC-KEY', receivingPublicAddress: 'PUBLIC-RECEIVING-ADDRESS', derivationPath: "m/44'/60'/0'/0/0", masterFingerprint: '11223344',
    protocol: { getIdentifier: async () => 'eth', getName: async () => 'Ethereum', getSymbol: async () => 'ETH' }
  }
  let opened = true, epoch = 1
  const access = {
    getContextId() { if (!opened) throw Error('Locked'); return epoch },
    assertContext(value) { if (!opened || value !== epoch) throw Error('Wallet context changed') },
    assertWallet(value, owner) { if (!opened || value !== wallet || (owner && owner !== secret)) throw Error('Foreign wallet') }
  }
  const navigation = {
    getState: () => ({ wallet, secret }),
    registerSensitiveCleanup(callback) { cleanups.add(callback); return () => cleanups.delete(callback) },
    routeWithState: async () => true, back() {}
  }
  const clipboard = { async copyAndShowToast(value) { copies.push(value) } }
  const popoverController = { async create() { return overlay() }, async dismiss() { return true } }
  const share = { async generateShareWalletURL() { return [{ payload: { publicKey: wallet.publicKey } }] } }
  const deeplink = { async generateDeepLinkUrl() { return 'PUBLIC-SHARE-URL' } }
  const page = new AccountAddressPage(popoverController, clipboard, share, {
    async startInteraction(value) { interactions.push(value) }
  }, navigation, { showTranslatedAlert: async () => undefined }, { runWalletsMigration: async () => undefined }, deeplink,
  { subscribe: () => new BehaviorSubject('basic') }, { navigate: async () => true }, access)
  page.ngOnInit(); page.ionViewWillEnter()
  return {
    page, access, navigation, wallet, secret, share, deeplink, clipboard, copies, interactions, popoverController, cleanups,
    lock() { opened = false; epoch++; [...cleanups].forEach((cleanup) => cleanup()) }
  }
}
function popoverFixture(setup = fixture()) {
  const alerts = []
  const alertController = { async create(options) { const instance = Object.assign(overlay(), { options }); alerts.push(instance); return instance } }
  const component = new AccountEditPopoverComponent(alertController, setup.clipboard, {
    async removeWallet() { component.deleted++ }
  }, setup.popoverController, { instant: (key) => key, get: () => of({}) }, setup.navigation, setup.access)
  Object.assign(component, { wallet: setup.wallet, contextId: 1, getWalletShareUrl: async () => 'PUBLIC-SHARE-URL', openAddressQR: () => undefined, deleted: 0 })
  return { setup, component, alerts, alertController }
}

test('the same active context can copy an address and return to a cached account page', async () => {
  const setup = fixture()
  await setup.page.copyAddressToClipboard()
  assert.deepEqual(setup.copies, ['PUBLIC-RECEIVING-ADDRESS'])
  setup.page.ionViewDidLeave()
  assert.equal(setup.page.canView, false)
  assert.equal(setup.page.wallet, undefined)
  setup.page.ionViewWillEnter()
  await tick()
  assert.equal(setup.page.canView, true)
  assert.equal(setup.page.wallet, setup.wallet)
  assert.equal(setup.page.protocolName, 'Ethereum')
})

test('lock clears cached account and QR/share data, dismisses overlays and blocks direct clipboard/menu calls', async () => {
  const setup = fixture()
  const modal = overlay(), popover = overlay()
  Object.assign(setup.page, { modal, editPopover: popover, shareObject: ['PUBLIC-OLD-QR'], walletShareUrl: 'PUBLIC-OLD-URL' })
  setup.lock()
  assert.equal(setup.page.canView, false)
  assert.equal(setup.page.wallet, undefined)
  assert.equal(setup.page.secret, undefined)
  assert.equal(setup.page.shareObject, undefined)
  assert.equal(setup.page.walletShareUrl, undefined)
  assert.ok(modal.state.dismissed > 0)
  assert.ok(popover.state.dismissed > 0)
  await assert.rejects(setup.page.copyAddressToClipboard())
  await assert.rejects(setup.page.share())
  await assert.rejects(setup.page.presentEditPopover({}))
  assert.deepEqual(setup.copies, [])
  assert.deepEqual(setup.interactions, [])
})

test('share generation completing after lock cannot repopulate shareObject or emit an interaction', async () => {
  const setup = fixture(), entered = deferred(), result = deferred()
  setup.share.generateShareWalletURL = () => { entered.resolve(); return result.promise }
  const pending = setup.page.share()
  await entered.promise
  setup.lock(); result.resolve(['PUBLIC-LATE-QR'])
  await assert.rejects(pending)
  assert.equal(setup.page.shareObject, undefined)
  assert.equal(setup.page.shareObjectPromise, undefined)
  assert.equal(setup.page.walletShareUrl, undefined)
  assert.deepEqual(setup.interactions, [])
})

test('late deep-link serialization cannot refill the cleared URL', async () => {
  const setup = fixture(), entered = deferred(), result = deferred()
  setup.deeplink.generateDeepLinkUrl = () => { entered.resolve(); return result.promise }
  const pending = setup.page.waitWalletShareUrl()
  await entered.promise
  setup.lock(); result.resolve('PUBLIC-LATE-URL')
  await assert.rejects(pending)
  assert.equal(setup.page.walletShareUrl, undefined)
  assert.equal(setup.page.shareObject, undefined)
})

test('a share from a previous page visit cannot replace a fresh same-context share after returning', async () => {
  const setup = fixture(), first = deferred(), second = deferred(), firstEntered = deferred(), secondEntered = deferred()
  let calls = 0
  setup.share.generateShareWalletURL = () => { if (++calls === 1) { firstEntered.resolve(); return first.promise } secondEntered.resolve(); return second.promise }
  const oldTask = setup.page.prepareSyncObject()
  await firstEntered.promise
  setup.page.ionViewDidLeave(); setup.page.ionViewWillEnter()
  const newTask = setup.page.prepareSyncObject()
  await secondEntered.promise
  second.resolve(['PUBLIC-NEW-QR']); await newTask
  first.resolve(['PUBLIC-OLD-QR']); await assert.rejects(oldTask)
  assert.deepEqual(setup.page.shareObject, ['PUBLIC-NEW-QR'])
  assert.equal(setup.page.canView, true)
})

test('a popover created after lock is dismissed before it can be presented', async () => {
  const setup = fixture(), created = deferred(), element = overlay()
  setup.popoverController.create = () => created.promise
  const pending = setup.page.presentEditPopover({})
  setup.lock(); created.resolve(element)
  await assert.rejects(pending)
  assert.equal(element.state.presented, 0)
  assert.ok(element.state.dismissed > 0)
})

test('popover copy and address actions reject after lock and erase cached wallet callbacks', async () => {
  const { setup, component } = popoverFixture()
  setup.lock()
  assert.equal(component.wallet, undefined)
  assert.equal(component.getWalletShareUrl, undefined)
  assert.equal(component.openAddressQR, undefined)
  assert.equal(component.canView, false)
  await assert.rejects(component.copyAddressToClipboard())
  await assert.rejects(component.copyShareUrlToClipboard())
  await assert.rejects(component.showAddressQR())
  await assert.rejects(component.openAddressExplorer())
  assert.deepEqual(setup.copies, [])
})

test('popover share URL finishing after lock is never copied to the clipboard', async () => {
  const { setup, component } = popoverFixture(), result = deferred()
  component.getWalletShareUrl = () => result.promise
  const pending = component.copyShareUrlToClipboard()
  setup.lock(); result.resolve('PUBLIC-LATE-QR-URL')
  await assert.rejects(pending)
  assert.deepEqual(setup.copies, [])
})

test('a retained delete-confirmation handler cannot mutate a wallet after lock', async () => {
  const { setup, component, alerts } = popoverFixture()
  await component.delete()
  const action = alerts[0].options.buttons[1].handler
  setup.lock()
  assert.ok(alerts[0].state.dismissed > 0)
  await assert.rejects(action())
  assert.equal(component.deleted, 0)
})

test('destroy unregisters sensitive cleanups and blocks cached component methods', async () => {
  const { setup, component } = popoverFixture()
  assert.equal(setup.cleanups.size, 2)
  component.ngOnDestroy(); setup.page.ngOnDestroy()
  assert.equal(setup.cleanups.size, 0)
  await assert.rejects(component.copyAddressToClipboard())
  await assert.rejects(setup.page.copyAddressToClipboard())
})
