const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

// See scripts/test-android-secure-storage.py for JDK/Kotlin prerequisites and
// the exact native boundaries simulated by this regression test.
test('Android secure storage preserves committed wallets across failed writes and authentication', { timeout: 60000 }, (context) => {
  const result = spawnSync('python3', [path.resolve(__dirname, '../scripts/test-android-secure-storage.py')], {
    encoding: 'utf8', timeout: 55000
  })
  if (result.status === 77) {
    context.skip(result.stderr.trim())
    return
  }
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /PASS cancel-authentication-cipher-1/)
  assert.match(result.stdout, /PASS cancel-authentication-cipher-2/)
  assert.match(result.stdout, /PASS deferred-recovery-key-commit/)
  assert.match(result.stdout, /PASS normal-paranoia-recovery-roundtrips/)
})
