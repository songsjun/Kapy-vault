const test = require('node:test')
const assert = require('node:assert/strict')
let api, actions
const ready = (async () => {
  await import('@angular/compiler')
  const store = await import('@ngrx/store')
  const core = {
    assertNever(name, value) { throw Error(name + ' ' + value) },
    flattened: (values) => values.flat(), generateGUID: () => 'public-id',
    UIActionStatus: { PENDING: 'pending', HANDLED: 'handled' },
    UIResourceStatus: { IDLE: 'idle', LOADING: 'loading', SUCCESS: 'success', ERROR: 'error' }
  }
  const load = require('./helpers/source-loader.cjs')({ '@ngrx/store': store, '@airgap/angular-core': core })
  api = load('src/app/pages/deserialized-detail/deserialized-detail.reducer.ts')
  actions = load('src/app/pages/deserialized-detail/deserialized-detail.actions.ts')
})()

test('an idle or closed signing view has no final payload and does not throw during effect subscription', async () => {
  await ready
  let state = api.reducer(undefined, { type: 'public-init' })
  assert.equal(api.selectFinalPayload({ deserializedDetail: state }), undefined)
  state = api.reducer(state, actions.navigationDataLoaded({ mode: 0, title: 'Public transaction', button: 'Sign', transactions: [{ type: 'unsigned', id: 1 }], messages: [], raw: 'public' }))
  assert.deepEqual(api.selectFinalPayload({ deserializedDetail: state }), { mode: 0, data: [{ type: 'unsigned', id: 1 }] })
  state = api.reducer(state, actions.viewClosed())
  assert.equal(api.selectFinalPayload({ deserializedDetail: state }), undefined)
  state = api.reducer(state, actions.operationCancelled())
  assert.equal(api.selectFinalPayload({ deserializedDetail: state }), undefined)
})

test('loaded transaction and message requests preserve their separate payloads', async () => {
  await ready
  const messages = [{ type: 'unsigned', id: 2 }]
  const state = api.reducer(undefined, actions.navigationDataLoaded({ mode: 1, title: 'Public message', button: 'Sign', transactions: [], messages, raw: 'public' }))
  assert.deepEqual(api.selectFinalPayload({ deserializedDetail: state }), { mode: 1, data: messages })
})
