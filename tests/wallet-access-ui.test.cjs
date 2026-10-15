// Public fixture strings only. These tests load the actual UI classes with native/UI ports stubbed.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { BehaviorSubject } = require('rxjs')

const root = path.resolve(__dirname, '..')
const status = { ACTIVE: 'active', HIDDEN: 'hidden', DELETED: 'deleted' }
const tick = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function load(relative, symbol) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, experimentalDecorators: true }
  }).outputText
  const module = { exports: {} }
  const noopDecorator = () => () => undefined
  vm.runInNewContext(output, {
    module, exports: module.exports, setTimeout, clearTimeout, Uint8Array,
    require(id) {
      if (id === '@angular/core') return { Component: noopDecorator, Input: noopDecorator }
      if (id === 'rxjs' || id === 'rxjs/operators') return require(id)
      if (id === '@airgap/coinlib-core') return { AirGapWalletStatus: status }
      if (id.includes('error-handler')) return { ErrorCategory: {}, handleErrorLocal: () => () => undefined }
      if (id.includes('storage/storage.service')) return { VaultStorageKey: {}, AdvancedModeType: { ADVANCED: 'advanced' } }
      if (id.includes('models/secret')) return { MnemonicSecret: class { constructor(entropy) { this.secretHex = entropy } } }
      return {}
    }
  }, { filename: relative })
  return module.exports[symbol]
}

const SecretAddPage = load('src/app/pages/secret-add/secret-add.page.ts', 'SecretAddPage')
const SecretItemComponent = load('src/app/components/secret-item/secret-item.component.ts', 'SecretItemComponent')
const SecretEditPage = load('src/app/pages/secret-edit/secret-edit.page.ts', 'SecretEditPage')
const AccountsListPage = load('src/app/pages/accounts-list/accounts-list.page.ts', 'AccountsListPage')
const AccountAddPage = load('src/app/pages/account-add/account-add.page.ts', 'AccountAddPage')
const translate = { instant: (key) => key }
const storage = { subscribe: () => new BehaviorSubject('basic'), get: async () => true }
const platform = { is: () => false }
const lifehash = { generateLifehash: async () => 'public-image' }

function navigation(secret) {
  const calls = []
  const nav = {
    calls, state: { secret }, getState: () => nav.state,
    routeToSecretsTab: async () => { calls.push({ route: 'secrets' }); return true },
    routeWithState: async (route, state) => { calls.push({ route, state }); return true },
    routeWithStateAsRoot: async (route, state) => { calls.push({ route, state }); return true },
    route: async (route) => { calls.push({ route }); return true }
  }
  return nav
}

function alerts() {
  const instances = []
  return {
    instances,
    async create(options) {
      const completion = deferred()
      const alert = {
        ...options, present: async () => { alert.presented = true },
        onDidDismiss: () => completion.promise,
        dismiss: async (_value, role) => { completion.resolve({ role }); return true }
      }
      instances.push(alert)
      return alert
    }
  }
}

function access(secret, wallets = [], isDefault = true) {
  const changes = new BehaviorSubject(undefined)
  const api = {
    current: secret, wallets, default: isDefault, configured: true, epoch: 0,
    changes$: changes.asObservable(),
    isConfigured: () => api.configured,
    isUnlocked: (candidate) => !!api.current && (!candidate || candidate.id === api.current.id),
    isDefaultUnlocked: (candidate) => api.isUnlocked(candidate) && api.default,
    getCurrentSecret: () => api.current,
    getWallets: (candidate) => api.isUnlocked(candidate) ? [...api.wallets] : [],
    lock() { api.epoch++; api.current = undefined; changes.next(undefined) },
    open(target, entries = wallets) { api.current = target; api.wallets = entries; changes.next({ secretId: target.id, epoch: api.epoch }) },
    unlock: async (target, password) => { assert.equal(password, 'public-default'); api.open(target) },
    listPassphrases: async () => [{ id: 'default', isDefault: true }, { id: 'branch-a', isDefault: false }],
    registerPassphrase: async () => undefined,
    removePassphrase: async () => undefined,
    changeDefaultPassword: async () => undefined
  }
  return api
}

function addFixture(create = async () => undefined) {
  const secret = { id: 'secret-a', label: 'Public fixture', fingerprint: 'aabbccdd' }
  const nav = navigation(secret)
  const calls = []
  let locks = 0
  const page = new SecretAddPage({ createSecret: async (...args) => { calls.push(args); await create() } }, nav, platform, lifehash, storage,
    { getTranslatedAlert: async () => ({ present: async () => undefined }) }, { lock: () => { locks++ } })
  return { page, nav, secret, calls, get locks() { return locks } }
}

test('creation requires a nonempty confirmed default password', async () => {
  const { page, calls } = addFixture()
  assert.equal(page.canSave, false)
  page.defaultPassword = 'public-default'
  page.confirmPassword = 'different'
  await page.confirm()
  assert.equal(calls.length, 0)
  page.confirmPassword = 'public-default'
  assert.equal(page.canSave, true)
})

test('creation uses the dedicated core API and clears password fields before navigation', async () => {
  const { page, nav, calls, secret } = addFixture()
  page.defaultPassword = page.confirmPassword = ' public-default '
  await page.confirm()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], secret)
  assert.equal(calls[0][1], ' public-default ')
  assert.equal(page.defaultPassword, '')
  assert.equal(page.confirmPassword, '')
  assert.equal(nav.calls[0].route, '/account-add')
  assert.deepEqual(Object.keys(nav.calls[0].state), ['secret'])
})

test('leaving creation prevents a delayed save from navigating back into accounts', async () => {
  const pending = deferred()
  const fixture = addFixture(() => pending.promise)
  const { page, nav } = fixture
  page.defaultPassword = page.confirmPassword = 'public-default'
  const operation = page.confirm()
  page.ionViewDidLeave()
  pending.resolve()
  await operation
  assert.equal(nav.calls.length, 0)
  assert.equal(page.defaultPassword, '')
  assert.equal(page.saving, false)
  assert.equal(fixture.locks, 1)
})

test('duplicate mnemonic creation reports that existing data was kept', async () => {
  const { page, nav } = addFixture(async () => { throw new Error('Already added secret') })
  let options
  page.uiEventService.getTranslatedAlert = async (value) => { options = value; return { present: async () => undefined } }
  page.defaultPassword = page.confirmPassword = 'public-default'
  await page.confirm()
  assert.equal(options.message, 'wallet-access.duplicate-message')
  assert.equal(page.defaultPassword, '')
  assert.equal(nav.calls.length, 0)
})

function cardFixture() {
  const secret = { id: 'secret-a', label: '<public-label>', fingerprint: 'aabbccdd' }
  const nav = navigation(secret), api = access(secret), prompt = alerts()
  const card = new SecretItemComponent(nav, lifehash, storage, api, prompt, translate)
  card.secret = secret
  return { card, secret, nav, api, prompt }
}

test('opening a Secret uses one password prompt and navigates without the password', async () => {
  const { card, nav, prompt } = cardFixture()
  const opening = card.goToAccountsList()
  await tick()
  const alert = prompt.instances[0]
  assert.equal(alert.message, 'wallet-access.unlock-message')
  const data = { password: 'public-default' }
  assert.equal(await alert.buttons[1].handler(data), true)
  assert.equal(data.password, '')
  await alert.dismiss(undefined, 'confirm')
  await opening
  assert.equal(alert.inputs.length, 0)
  assert.equal(nav.calls[0].route, '/accounts-list')
  assert.deepEqual(Object.keys(nav.calls[0].state), ['secret'])
})

test('an unknown password stays in the prompt, clears input and never opens accounts', async () => {
  const { card, api, nav, prompt } = cardFixture()
  api.unlock = async () => { throw new Error('not registered') }
  const opening = card.goToAccountsList()
  await tick()
  const alert = prompt.instances[0]
  assert.equal(await alert.buttons[1].handler({ password: 'unknown' }), false)
  assert.equal(alert.message, 'wallet-access.unlock-error')
  assert.equal(alert.inputs[0].value, undefined)
  assert.equal(nav.calls.length, 0)
  alert.buttons[0].handler()
  await alert.dismiss(undefined, 'cancel')
  await opening
  assert.equal(api.isUnlocked(), false)
  assert.equal(alert.inputs.length, 0)
})

test('cancel during native verification revokes the pending attempt and prevents late navigation', async () => {
  const { card, api, nav, prompt, secret } = cardFixture()
  const pending = deferred()
  api.unlock = async () => {
    const epoch = api.epoch
    await pending.promise
    if (epoch !== api.epoch) throw new Error('cancelled')
    api.open(secret)
  }
  const opening = card.goToAccountsList()
  await tick()
  const alert = prompt.instances[0]
  const unlock = alert.buttons[1].handler({ password: 'public-default' })
  alert.buttons[0].handler()
  await alert.dismiss(undefined, 'cancel')
  await opening
  pending.resolve()
  assert.equal(await unlock, false)
  assert.equal(api.isUnlocked(), false)
  assert.equal(nav.calls.length, 0)
})

test('legacy Secrets show a preservation warning and do not silently configure or enter accounts', async () => {
  const { card, api, nav, prompt } = cardFixture()
  api.configured = false
  const opening = card.goToAccountsList()
  await tick()
  assert.equal(prompt.instances[0].message, 'wallet-access.legacy-message')
  await prompt.instances[0].dismiss(undefined, 'confirm')
  await opening
  assert.equal(nav.calls.length, 0)
})

test('destroying the Secret card dismisses and clears its password prompt', async () => {
  const { card, nav, prompt } = cardFixture()
  const opening = card.goToAccountsList()
  await tick()
  card.ngOnDestroy()
  await opening
  assert.equal(prompt.instances[0].inputs.length, 0)
  assert.equal(nav.calls.length, 0)
})

function listFixture(name = async () => 'Ethereum') {
  const wallet = { publicKey: 'public-a', status: status.ACTIVE, protocol: { getName: name } }
  const other = { publicKey: 'public-b', status: status.ACTIVE, protocol: { getName: async () => 'Bitcoin' } }
  const secret = { id: 'secret-a', wallets: [wallet, other] }
  const nav = navigation(secret), api = access(secret, [wallet]), prompt = alerts()
  const writes = []
  const page = new AccountsListPage(platform, nav, { strategy: async () => ({ syncAll: async () => undefined }) }, prompt, translate,
    { removeWallet: async (entry) => writes.push(entry), removeWallets: async (entries) => writes.push(...entries) }, prompt, api)
  return { page, api, nav, prompt, wallet, other, secret, writes }
}

test('account list shows only the authorized branch, even when the old object has more accounts', async () => {
  const { page, wallet } = listFixture()
  page.ionViewWillEnter()
  await tick()
  assert.equal(page.wallets$.value.length, 1)
  assert.equal(page.wallets$.value[0], wallet)
  page.ngOnDestroy()
})

test('a locked account list rejects the old navigation object', async () => {
  const { page, api, nav } = listFixture()
  api.lock()
  page.ionViewWillEnter()
  await tick()
  assert.equal(page.canView, false)
  assert.equal(page.wallets$.value.length, 0)
  assert.equal(nav.calls[0].route, 'secrets')
  page.ngOnDestroy()
})

test('locking clears accounts immediately and prevents a delayed name lookup from republishing them', async () => {
  const pending = deferred()
  const { page, api } = listFixture(() => pending.promise)
  page.ionViewWillEnter()
  api.lock()
  assert.equal(page.wallets$.value.length, 0)
  pending.resolve('Ethereum')
  await tick()
  assert.equal(page.wallets$.value.length, 0)
  assert.equal(page.canView, false)
  page.ngOnDestroy()
})

test('another branch account cannot be opened, selected or deleted by a stale UI reference', async () => {
  const { page, other, prompt, nav, writes } = listFixture()
  page.ionViewWillEnter()
  await tick()
  page.goToReceiveAddress(other)
  page.onWalletSelected({ detail: { checked: true } }, other)
  await page.delete(other)
  assert.equal(nav.calls.length, 0)
  assert.equal(page.selectedWallets.length, 0)
  assert.equal(prompt.instances.length, 0)
  assert.equal(writes.length, 0)
  page.ngOnDestroy()
})

test('a Pi branch cannot enter Secret management from the account list', async () => {
  const { page, api, nav } = listFixture()
  api.default = false
  page.ionViewWillEnter()
  await tick()
  page.goToEditSecret()
  assert.equal(nav.calls.length, 0)
  page.ngOnDestroy()
})

function editFixture(isDefault = true) {
  const secret = { id: 'secret-a', label: 'Public fixture' }
  const nav = navigation(secret), api = access(secret, [], isDefault), prompt = alerts()
  const writes = []
  api.registerPassphrase = async (_secret, password) => writes.push(['register', password])
  api.changeDefaultPassword = async (_secret, password) => writes.push(['default', password])
  api.removePassphrase = async (_secret, id) => writes.push(['remove', id])
  const secretService = { retrieveEntropyForSecret: async () => { writes.push(['entropy']); return '00' } }
  const page = new SecretEditPage({ create: async () => ({ present: async () => undefined }) }, prompt, translate, {}, secretService,
    nav, storage, lifehash, platform, { navigate: async () => true }, { dismiss: async () => undefined }, api)
  return { page, api, nav, prompt, writes }
}

test('management requires the default branch and cannot register from a Pi branch', async () => {
  const { page, nav, writes } = editFixture(false)
  await page.ionViewWillEnter()
  page.newPassphrase = page.confirmPassphrase = 'public-pi'
  await page.registerPassphrase()
  assert.equal(page.canManage, false)
  assert.equal(page.passphrases.length, 0)
  assert.equal(writes.length, 0)
  assert.equal(nav.calls[0].route, 'secrets')
  page.ngOnDestroy()
})

test('management registers the exact confirmed Pi and clears all form password fields', async () => {
  const { page, writes } = editFixture()
  await page.ionViewWillEnter()
  assert.equal(page.passphrases.length, 1)
  assert.equal(page.passphrases[0].id, 'branch-a')
  page.newPassphrase = page.confirmPassphrase = ' public-PI '
  await page.registerPassphrase()
  assert.deepEqual(writes, [['register', ' public-PI ']])
  assert.equal(page.newPassphrase, '')
  assert.equal(page.confirmPassphrase, '')
  page.ngOnDestroy()
})

test('changing D uses the gate API and does not create an account or navigate', async () => {
  const { page, writes, nav } = editFixture()
  await page.ionViewWillEnter()
  page.newDefaultPassword = page.confirmDefaultPassword = 'new-public-default'
  await page.changeDefaultPassword()
  assert.deepEqual(writes, [['default', 'new-public-default']])
  assert.equal(nav.calls.length, 0)
  assert.equal(page.newDefaultPassword, '')
  page.ngOnDestroy()
})

test('a mnemonic confirmation opened before locking cannot reveal entropy after locking', async () => {
  const { page, api, prompt, writes } = editFixture()
  await page.ionViewWillEnter()
  await page.showMnemonic()
  const confirm = prompt.instances[0].buttons[1].handler
  api.lock()
  await confirm(['understood'])
  assert.equal(writes.length, 0)
  assert.equal(page.canManage, false)
  page.ngOnDestroy()
})

test('locking clears a recovery key already visible in a global management alert', async () => {
  const { page, api, prompt } = editFixture()
  page.secretsService.resetRecoveryPassword = async () => 'public-recovery-key'
  await page.ionViewWillEnter()
  await page.resetRecoveryPassword()
  assert.equal(prompt.instances[0].message, 'public-recovery-key')
  api.lock()
  assert.equal(prompt.instances[0].message, '')
  assert.equal(prompt.instances[0].buttons.length, 0)
  assert.equal(prompt.instances[0].inputs.length, 0)
  page.ngOnDestroy()
})

test('a recovery key returned after locking is not shown in a new alert', async () => {
  const { page, api, prompt } = editFixture()
  const pending = deferred()
  page.secretsService.resetRecoveryPassword = () => pending.promise
  await page.ionViewWillEnter()
  const resetting = page.resetRecoveryPassword()
  api.lock()
  pending.resolve('public-recovery-key')
  await resetting
  assert.equal(prompt.instances.length, 0)
  page.ngOnDestroy()
})

test('management cancellation/leave clears all plaintext form fields', async () => {
  const { page } = editFixture()
  await page.ionViewWillEnter()
  page.newPassphrase = page.confirmPassphrase = 'public-pi'
  page.newDefaultPassword = page.confirmDefaultPassword = 'public-default'
  page.ionViewDidLeave()
  for (const field of ['newPassphrase', 'confirmPassphrase', 'newDefaultPassword', 'confirmDefaultPassword']) assert.equal(page[field], '')
  assert.equal(page.passphrases.length, 0)
  page.ngOnDestroy()
})

test('a removal confirmation cannot remove a branch after default authorization is lost', async () => {
  const { page, api, prompt, writes } = editFixture()
  await page.ionViewWillEnter()
  await page.removePassphrase('branch-a')
  const confirm = prompt.instances[0].buttons[1].handler
  api.lock()
  await confirm()
  assert.equal(writes.length, 0)
  page.ngOnDestroy()
})

test('account addition uses current branch authorization and sends no separate BIP39 password', async () => {
  const secret = { id: 'secret-a' }, nav = navigation(secret), api = access(secret)
  const calls = []
  const protocol = { getIdentifier: async () => 'eth', getStandardDerivationPath: async () => "m/44'/60'/0'" }
  const page = new AccountAddPage({ addWallets: async (_secret, configs) => { calls.push(configs); return [] } }, storage,
    { getActiveProtocols: async () => [] }, {}, nav, api)
  page.ionViewWillEnter()
  await tick()
  page.protocolList = [{ protocol, isChecked: true, isHDWallet: true, customDerivationPath: "m/44'/60'/0'" }]
  page.formValid = true
  await page.addWallet()
  assert.equal(calls.length, 1)
  assert.equal('bip39Passphrase' in calls[0][0], false)
  assert.equal(nav.calls[0].route, '/accounts-list')
  page.ngOnDestroy()
})

test('account addition does not run after authorization is lost during protocol preparation', async () => {
  const secret = { id: 'secret-a' }, nav = navigation(secret), api = access(secret), pending = deferred()
  let writes = 0
  const page = new AccountAddPage({ addWallets: async () => { writes++; return [] } }, storage,
    { getActiveProtocols: async () => [] }, {}, nav, api)
  page.ionViewWillEnter()
  await tick()
  page.protocolList = [{ protocol: { getIdentifier: () => pending.promise }, isChecked: true, isHDWallet: true, customDerivationPath: 'm/0' }]
  page.formValid = true
  const adding = page.addWallet()
  await tick()
  api.lock()
  pending.resolve('eth')
  await adding
  assert.equal(writes, 0)
  assert.equal(page.canAdd, false)
  page.ngOnDestroy()
})
