const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const sourceLoader = require('./helpers/source-loader.cjs')

const repository = path.resolve(__dirname, '..')
const workspace = path.dirname(repository)
const appDirectory = (directory) => directory === 'airgap-vault' ? repository : path.join(workspace, directory)
const messages = ['First harmless review message', 'Second harmless review message']
const contextId = 7
const actionFactory = (type) => Object.assign((value = {}) => ({ ...value, type }), { type })

function loadApp(directory) {
  const root = appDirectory(directory)
  const load = sourceLoader({
    '@airgap/angular-core': { BaseIACService: class {} },
    '@ngrx/store': { createAction: actionFactory, props: () => undefined },
    '@ngrx/effects': { createEffect: () => undefined },
    '@airgap/tezos': {},
    '@ionic/angular': {},
    'bip39': { entropyToMnemonic: () => 'PUBLIC-FIXTURE-MNEMONIC' },
    './deserialized-detail.reducer': {},
    '../../services/interaction/interaction.service': { InteractionOperationType: {} },
    '../interaction/interaction.service': { InteractionOperationType: {} },
    '../error-handler/error-handler.service': { ErrorCategory: {}, handleErrorLocal: () => () => undefined },
    '../bitcoin-multisig/bitcoin-multisig.service': {},
    'src/app/pages/select-account/select-account.page': {},
    '../../services/session/session-guard': {}
  })
  return {
    root,
    IACService: load(path.join(root, 'src/app/services/iac/iac.service.ts')).IACService,
    Effects: load(path.join(root, 'src/app/pages/deserialized-detail/deserialized-detail.effects.ts')).DeserializedDetailEffects,
    Component: load(path.join(root, 'src/app/components/message-sign-request/message-sign-request.component.ts')).MessageSignRequestComponent,
    actions: load(path.join(root, 'src/app/pages/deserialized-detail/deserialized-detail.actions.ts'))
  }
}

function request(message, id) {
  return { id, protocol: 'eth', payload: { publicKey: 'PUBLIC-FIXTURE-ACCOUNT', message } }
}

for (const directory of ['airgap-vault', 'web', 'web-local']) {
  // The repository can be cloned under any name without optional Web siblings.
  if (directory !== 'airgap-vault' && !fs.existsSync(path.join(appDirectory(directory), 'src/app/services/iac/iac.service.ts'))) {
    test(`${directory}: optional sibling message review checks`, { skip: 'Sibling Web workspace is not present in this standalone clone.' }, () => {})
    continue
  }
  const app = loadApp(directory)

  test(`${directory}: two harmless message requests are rejected before account selection or navigation`, async () => {
    const alerts = [], matched = [], navigated = []
    const service = Object.create(app.IACService.prototype)
    Object.assign(service, {
      access: { isUnlocked: () => true, getContextId: () => contextId, assertContext: () => undefined },
      uiEventService: { showTranslatedAlert: async (value) => alerts.push(value) },
      findMatchingSignWallet: async (value) => { matched.push(value); return value },
      navigationService: { routeWithState: async (...value) => navigated.push(value) }
    })
    const result = await service.handleMessageSignRequest({ result: messages.map(request) }, undefined, () => undefined)
    assert.equal(result, false)
    assert.equal(alerts.length, 1)
    assert.match(alerts[0].message, /each message separately/)
    assert.deepEqual(matched, [])
    assert.deepEqual(navigated, [])
  })

  test(`${directory}: a batch inserted directly into signing state cannot read secrets or invoke the signer`, async () => {
    let entropyReads = 0, signatureCalls = 0
    const effect = Object.create(app.Effects.prototype)
    Object.assign(effect, {
      pageContextId: contextId,
      access: {
        assertContext: () => undefined, assertWallet: () => undefined,
        getCurrentSecret: () => ({ id: 'PUBLIC-FIXTURE' }), getPassphrase: () => ''
      },
      session: { assertUsable: () => undefined },
      secretsService: { retrieveEntropyForSecret: async () => { entropyReads++; return 'PUBLIC-FIXTURE-ENTROPY' } },
      keyPairService: { signWithProtocol: async () => { signatureCalls++; return 'PUBLIC-STUB-SIGNATURE' } }
    })
    const result = await effect.signMessages(messages.map((message, id) => ({
      id, protocol: 'eth', type: 'unsigned', wallet: { publicKey: 'PUBLIC-FIXTURE-ACCOUNT' }, data: { message }
    })), contextId)
    assert.equal(result.type, app.actions.unknownError.type)
    assert.match(result.message, /one message at a time/)
    assert.equal(entropyReads, 0)
    assert.equal(signatureCalls, 0)
  })

  test(`${directory}: one harmless message retains the existing account and signing flow`, async () => {
    const navigated = [], signed = []
    const service = Object.create(app.IACService.prototype)
    const wallet = { publicKey: 'PUBLIC-FIXTURE-ACCOUNT', derivationPath: "m/44'/60'/0'/0/0", protocol: {} }
    const secret = { id: 'PUBLIC-FIXTURE' }
    const access = {
      isUnlocked: () => true, getContextId: () => contextId, assertContext: () => undefined,
      assertWallet: () => undefined, getCurrentSecret: () => secret, getPassphrase: () => ''
    }
    Object.assign(service, {
      access, findMatchingSignWallet: async (value) => ({ wallet, secret, signTransactionRequest: value }),
      navigationService: { routeWithState: async (...value) => navigated.push(value) }
    })
    const input = request(messages[0], 1)
    assert.equal(await service.handleMessageSignRequest({ result: [input] }, undefined, () => undefined), true)
    assert.equal(navigated.length, 1)
    assert.equal(navigated[0][1].transactionInfos.length, 1)

    const effect = Object.create(app.Effects.prototype)
    Object.assign(effect, {
      pageContextId: contextId, access, session: { assertUsable: () => undefined },
      secretsService: { retrieveEntropyForSecret: async () => 'PUBLIC-FIXTURE-ENTROPY' },
      keyPairService: { signWithProtocol: async (_protocol, data) => { signed.push(data); return 'PUBLIC-STUB-SIGNATURE' } }
    })
    const result = await effect.signMessages([{ id: 1, type: 'unsigned', protocol: 'eth', wallet, data: input.payload }], contextId)
    assert.equal(result.type, app.actions.messagesSigned.type)
    assert.equal(result.messages.length, 1)
    assert.equal(signed.length, 1)
    assert.equal(signed[0].message, messages[0])
  })

  test(`${directory}: review retains both harmless messages and copies the selected original message`, async () => {
    const copied = []
    const component = new app.Component({ copyAndShowToast: async (value) => copied.push(value) })
    const encoded = messages.map((message) => '0x' + Buffer.from(message).toString('hex'))
    component.messages = encoded.map((data) => ({ data }))
    assert.deepEqual(component._messages.map((message) => message.data), messages)
    await component.copyEncodedMessage(1)
    await component.copyEncodedMessage(0)
    assert.deepEqual(copied, [encoded[1], encoded[0]])
    const template = fs.readFileSync(path.join(app.root, 'src/app/components/message-sign-request/message-sign-request.component.html'), 'utf8')
    const { parseTemplate } = await import('@angular/compiler')
    assert.equal(parseTemplate(template, 'message-review.html').errors, null)
    assert.match(template, /\*ngFor="let message of _messages; let i = index"/)
    assert.doesNotMatch(template, /_messages\[0\]/)
  })
}
