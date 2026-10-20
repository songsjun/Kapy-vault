const test = require('node:test')
const assert = require('node:assert/strict')
const { redactSensitive } = require('./helpers/source-loader.cjs')({})('src/app/services/error-handler/redact.ts')

test('error history redacts key, seed and mnemonic material', () => {
  const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  const hex = 'a'.repeat(64)
  const xprv = 'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi'
  const redacted = redactSensitive(`failed for ${mnemonic} with 0x${hex} and ${xprv}`)
  assert.doesNotMatch(redacted, /abandon|about/)
  assert.ok(!redacted.includes(hex))
  assert.ok(!redacted.includes(xprv))
  assert.match(redacted, /\[redacted-words\].*\[redacted-hex\].*\[redacted-base58\]/)
})

test('error history keeps ordinary messages readable', () => {
  assert.equal(redactSensitive('Navigation failed: route not found'), 'Navigation failed: route not found')
  assert.equal(redactSensitive(undefined), undefined)
})
