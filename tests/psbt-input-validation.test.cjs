const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const sourceLoader = require('./helpers/source-loader.cjs')
const { Psbt, Transaction, payments } = require('@airgap/coinlib-core/dependencies/src/bitcoinjs-lib-6.1.7/src/index')
const { IACMessageType } = require('@airgap/serializer')
const repository = path.resolve(__dirname, '..')
const workspace = path.dirname(repository)
const publicKey = { type: 'pub', format: 'hex', value: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' }
const script = payments.p2pkh({ hash: Buffer.alloc(20, 1) }).output
// Public, unsigned synthetic transactions only. No secret key or signature is used.
function fixture(options = {}) {
  const previous = new Transaction()
  previous.addInput(Buffer.alloc(32, 1), 0); previous.addOutput(script, 100000)
  const psbt = new Psbt()
  psbt.addInput({ hash: options.badHash ? Buffer.alloc(32, 2) : previous.getHash(), index: options.badIndex ? 1 : 0,
    ...(options.full === false ? {} : { nonWitnessUtxo: previous.toBuffer() }),
    ...(options.witness === false ? {} : { witnessUtxo: { value: options.value ?? 100000,
      script: options.badScript ? payments.p2pkh({ hash: Buffer.alloc(20, 2) }).output : script } }) })
  psbt.addOutput({ script, value: options.negativeFee ? 100001 : 90000 })
  return { transaction: { psbt: psbt.toHex() }, publicKey: publicKey.value }
}
const ready = (async () => { await import('@angular/compiler'); return import('@ngrx/store') })()
function appLoader(store) {
  return sourceLoader({
    '@airgap/angular-core': { assertNever: () => { throw Error('Unexpected mode') }, flattened: (values) => values.flat(),
      generateGUID: () => 'public-id', UIActionStatus: { PENDING: 'pending', HANDLED: 'handled' },
      UIResourceStatus: { IDLE: 'idle', LOADING: 'loading', SUCCESS: 'success', ERROR: 'error' } },
    '@ngrx/store': store, '@ngrx/effects': { createEffect: () => undefined }, '@airgap/tezos': {},
    '../../services/interaction/interaction.service': { InteractionOperationType: {} }, '../../services/session/session-guard': {}
  })
}
for (const directory of ['airgap-vault', 'web', 'web-local']) {
  const root = directory === 'airgap-vault' ? repository : path.join(workspace, directory)
  if (directory !== 'airgap-vault' && !fs.existsSync(path.join(root, 'src/app/services/bitcoin/psbt-input-validation.ts'))) {
    test(`${directory}: optional sibling PSBT checks`, { skip: 'Sibling Web workspace is not present in this standalone clone.' }, () => {})
    continue
  }
  const appFile = (file) => path.join(root, 'src/app', file)
  const detailFile = (file) => appFile('pages/deserialized-detail/' + file)
  test(`${directory}: complete input references pass and conflicting or missing prevouts fail`, async () => {
    const load = appLoader(await ready)
    const { validatePsbtTransactionInputs: check, PsbtInputValidationError } = load(appFile('services/bitcoin/psbt-input-validation.ts'))
    assert.doesNotThrow(() => check('btc', fixture())); assert.doesNotThrow(() => check('btc', fixture({ witness: false })))
    for (const id of ['btc_segwit', 'btc_taproot']) assert.doesNotThrow(() => check(id, fixture({ full: false })))
    for (const options of [{ value: 91000 }, { badScript: true }, { badHash: true }, { badIndex: true }, { negativeFee: true }]) {
      assert.throws(() => check('btc', fixture(options)), PsbtInputValidationError)
    }
    assert.throws(() => check('btc', fixture({ full: false })), /full previous transaction/)
    assert.throws(() => check('btc', fixture({ full: false, witness: false })), /full previous transaction/)
    for (const id of ['btc_segwit', 'btc_taproot']) assert.throws(() => check(id, fixture({ witness: false })), /witness UTXO/)
    for (const psbt of ['', 'xyz', '00'.repeat(2 * 1024 * 1024 + 1)]) assert.throws(() => check('btc', { transaction: { psbt } }), PsbtInputValidationError)
    assert.doesNotThrow(() => check('eth', { transaction: { nonce: '0' } }))
  })
  test(`${directory}: actual BTC module reaches the conflicting legacy fee renderer without signing`, async () => {
    const { BitcoinModule } = require(path.join(root, 'node_modules/@airgap/bitcoin/v1/module/BitcoinModule.js'))
    const protocol = await new BitcoinModule().createOfflineProtocol('btc')
    assert.equal(protocol.constructor.name, 'BitcoinLegacyProtocolImpl')
    const details = await protocol.getDetailsFromTransaction({ type: 'unsigned', ...fixture({ value: 91000 }).transaction }, publicKey)
    assert.equal(details[0].fee.value, '1000') // Actual previous output minus new output: 100000 - 90000 = 10000.
    const { validatePsbtTransactionInputs: check } = appLoader(await ready)(appFile('services/bitcoin/psbt-input-validation.ts'))
    assert.throws(() => check('btc', fixture({ value: 91000 })), /disagree/)
  })
  test(`${directory}: invalid review revokes an old approval and payload instead of exposing blind signing`, async () => {
    const load = appLoader(await ready)
    const { DeserializedDetailEffects } = load(detailFile('deserialized-detail.effects.ts'))
    const actions = load(detailFile('deserialized-detail.actions.ts')), reducer = load(detailFile('deserialized-detail.reducer.ts'))
    const wallet = { publicKey: publicKey.value, protocol: { getIdentifier: async () => 'btc', getSymbol: async () => 'BTC' } }
    let detailsCalls = 0
    const effect = Object.create(DeserializedDetailEffects.prototype)
    Object.assign(effect, { pageContextId: 7, session: { assertUsable() {} }, access: { assertContext() {}, assertWallet() {} },
      navigationService: { getState: () => ({ contextId: 7, type: IACMessageType.TransactionSignRequest, transactionInfos: [{ wallet,
        signTransactionRequest: { type: IACMessageType.TransactionSignRequest, protocol: 'btc', payload: fixture({ value: 91000 }) } }] }) },
      translateService: { instant: (value) => value }, transactionService: { getDetailsFromIACMessages: async () => { detailsCalls++; return [] } } })
    const action = await effect.loadNavigationData()
    assert.equal(action.type, actions.invalidTransactionInputs.type); assert.equal(detailsCalls, 0); assert.equal(effect.pageContextId, undefined)
    const prior = reducer.reducer(undefined, actions.navigationDataLoaded({ mode: 0, title: 'Prior public request', button: 'Sign',
      transactions: [{ type: 'unsigned', data: fixture() }], messages: [], raw: 'public' }))
    const state = reducer.reducer(prior, action)
    assert.equal(state.button, undefined); assert.equal(state.raw.value, undefined)
    assert.equal(reducer.selectFinalPayload({ deserializedDetail: state }), undefined); assert.match(state.alert.value.message, /Invalid Bitcoin PSBT/)
  })
  test(`${directory}: direct signing-state bypass rejects the entire invalid batch before reading entropy`, async () => {
    const load = appLoader(await ready)
    const { DeserializedDetailEffects } = load(detailFile('deserialized-detail.effects.ts'))
    const actions = load(detailFile('deserialized-detail.actions.ts'))
    const wallet = { publicKey: publicKey.value, protocol: { getIdentifier: async () => 'btc' } }
    let entropyReads = 0, signerCalls = 0
    const effect = Object.create(DeserializedDetailEffects.prototype)
    Object.assign(effect, { pageContextId: 7, session: { assertUsable() {} }, access: { assertContext() {}, assertWallet() {}, getCurrentSecret: () => ({}) },
      secretsService: { retrieveEntropyForSecret: async () => { entropyReads++; throw Error('No entropy needed') } },
      keyPairService: { signWithProtocol: async () => { signerCalls++; throw Error('No signature may be generated') } } })
    const action = await effect.signTransactions([{ wallet, data: fixture() }, { wallet, data: fixture({ value: 91000 }) }], 7)
    assert.equal(action.type, actions.invalidTransactionInputs.type); assert.equal(entropyReads, 0); assert.equal(signerCalls, 0)
    effect.pageContextId = 7
    await assert.rejects(effect.signTransaction(wallet, fixture({ badScript: true }), undefined, 7), /disagree/)
    assert.equal(entropyReads, 0); assert.equal(signerCalls, 0)
  })
  test(`${directory}: consistent BTC input reaches normal review and the signing hook without generating a real signature`, async () => {
    const load = appLoader(await ready)
    const { DeserializedDetailEffects } = load(detailFile('deserialized-detail.effects.ts'))
    const actions = load(detailFile('deserialized-detail.actions.ts'))
    const { BitcoinModule } = require(path.join(root, 'node_modules/@airgap/bitcoin/v1/module/BitcoinModule.js'))
    const protocol = await new BitcoinModule().createOfflineProtocol('btc')
    const wallet = { publicKey: publicKey.value, derivationPath: "m/44'/0'/0'", protocol: {
      getIdentifier: async () => 'btc', getSymbol: async () => 'BTC' } }
    const data = fixture(); let detailsCalls = 0, entropyReads = 0, signerCalls = 0
    const effect = Object.create(DeserializedDetailEffects.prototype)
    Object.assign(effect, { pageContextId: 7, session: { assertUsable() {} }, access: {
      assertContext() {}, assertWallet() {}, getCurrentSecret: () => ({}), getPassphrase: () => '' },
      navigationService: { getState: () => ({ contextId: 7, type: IACMessageType.TransactionSignRequest, transactionInfos: [{ wallet,
        signTransactionRequest: { type: IACMessageType.TransactionSignRequest, protocol: 'btc', payload: data } }] }) },
      translateService: { instant: (value) => value }, transactionService: { getDetailsFromIACMessages: async () => {
        detailsCalls++; return protocol.getDetailsFromTransaction({ type: 'unsigned', ...data.transaction }, publicKey)
      } },
      secretsService: { retrieveEntropyForSecret: async () => { entropyReads++; return '00'.repeat(16) } },
      keyPairService: { signWithProtocol: async () => { signerCalls++; return 'PUBLIC-STUB-RESULT-NOT-A-SIGNATURE' } }
    })
    const reviewed = await effect.loadNavigationData()
    assert.equal(reviewed.type, actions.navigationDataLoaded.type)
    assert.equal(detailsCalls, 1); assert.equal(reviewed.transactions[0].details[0].fee.value, '10000')
    assert.equal(entropyReads, 0); assert.equal(signerCalls, 0)
    const signed = await effect.signTransactions(reviewed.transactions, 7)
    assert.equal(signed.type, actions.transactionsSigned.type); assert.equal(entropyReads, 1); assert.equal(signerCalls, 1)
  })
}
