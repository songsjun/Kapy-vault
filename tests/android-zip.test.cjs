const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

test('Android ZIP extraction preserves files outside its staging directory', { timeout: 60000 }, (context) => {
  const result = spawnSync('python3', [path.resolve(__dirname, '../scripts/test-android-zip.py')], {
    encoding: 'utf8', timeout: 55000
  })
  if (result.status === 77) {
    context.skip(result.stderr.trim())
    return
  }
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /OK \(4 tests\)/)
})
