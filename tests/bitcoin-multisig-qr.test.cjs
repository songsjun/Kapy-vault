const assert = require('node:assert/strict')
const test = require('node:test')
const { UR, UREncoder, URDecoder } = require('@ngraveio/bc-ur')
const { CryptoAccount, CryptoPSBT } = require('@keystonehq/bc-ur-registry')
const { FountainEncoderPart } = require('@ngraveio/bc-ur/dist/fountainEncoder')
const bytewords = require('@ngraveio/bc-ur/dist/bytewords').default
const load = require('./helpers/source-loader.cjs')()
const { multisigCosignerEncoder, multisigPsbtEncoder, MultisigPsbtQrDecoder } =
  load('src/app/services/bitcoin-multisig/bitcoin-multisig-qr.ts')
const { MNEMONICS, accountPath, rootFor, fixture, parse, verifySignatures } = require('./helpers/multisig-fixtures.cjs')

function externalDecode(encoder) {
  const decoder = new URDecoder()
  for (const frame of encoder.encodeWhole().reverse()) decoder.receivePart(frame)
  assert.equal(decoder.isSuccess(), true)
  return decoder.resultUR()
}

function externalEncoder(hex, fragmentLength = 70) {
  return new UREncoder(new CryptoPSBT(Buffer.from(hex, 'hex')).toUR(), fragmentLength)
}

function singleFrame(hex) {
  return UREncoder.encodeSinglePart(new CryptoPSBT(Buffer.from(hex, 'hex')).toUR())
}

function forgedFrame({ seqNum = 1, seqLength = 2, messageLength = 20, checksum = 123,
  fragment = Buffer.alloc(10, 1), uriSequence = seqNum, uriLength = seqLength } = {}) {
  const part = new FountainEncoderPart(seqNum, seqLength, messageLength, checksum, fragment)
  const payload = bytewords.encode(part.cbor().toString('hex'), bytewords.STYLES.MINIMAL)
  return `ur:crypto-psbt/${uriSequence}-${uriLength}/${payload}`
}

for (const scriptType of ['p2sh', 'p2sh-p2wsh', 'p2wsh']) {
  test(`${scriptType}: crypto-account QR exports the exact public key, chain code, fingerprint, origin, depth, and network`, () => {
    for (const network of ['mainnet', 'testnet', 'signet', 'regtest']) {
      const root = rootFor(MNEMONICS[0], 'Public QR fixture', network)
      const derivationPath = accountPath(scriptType, network)
      const child = root.derivePath(derivationPath)
      const cosigner = { xpub: child.neutered().toBase58(), masterFingerprint: root.fingerprint.toString('hex'),
        derivationPath, network, scriptType }
      const ur = externalDecode(multisigCosignerEncoder(cosigner))
      assert.equal(ur.type, 'crypto-account')
      const account = CryptoAccount.fromCBOR(ur.cbor)
      assert.deepEqual(account.getMasterFingerprint(), root.fingerprint)
      assert.equal(account.getOutputDescriptors().length, 1)
      const output = account.getOutputDescriptors()[0]
      const expectedExpressions = { p2sh: ['sh'], 'p2sh-p2wsh': ['sh', 'wsh'], p2wsh: ['wsh'] }
      assert.deepEqual(output.getScriptExpressions().map((expression) => expression.getExpression()), expectedExpressions[scriptType])
      const hdKey = output.getHDKey()
      assert.equal(hdKey.isMaster(), false)
      assert.equal(hdKey.isPrivateKey(), false)
      assert.deepEqual(hdKey.getKey(), child.publicKey)
      assert.deepEqual(hdKey.getChainCode(), child.chainCode)
      assert.equal(hdKey.getOrigin().getPath(), derivationPath.slice(2))
      assert.equal(hdKey.getOrigin().getDepth(), child.depth)
      assert.deepEqual(hdKey.getOrigin().getSourceFingerprint(), root.fingerprint)
      assert.deepEqual(hdKey.getOrigin().getComponents().map((component) => ({ index: component.getIndex(), hardened: component.isHardened() })),
        derivationPath.split('/').slice(1).map((component) => ({ index: Number(component.slice(0, -1)), hardened: true })))
      const parentFingerprint = Buffer.alloc(4)
      parentFingerprint.writeUInt32BE(child.parentFingerprint)
      assert.deepEqual(hdKey.getParentFingerprint(), parentFingerprint)
      assert.equal(hdKey.getUseInfo().getType(), 0)
      assert.equal(hdKey.getUseInfo().getNetwork(), network === 'mainnet' ? 0 : 1)
      assert.equal(ur.cbor.includes(Buffer.from(MNEMONICS[0])), false)
      assert.equal(ur.cbor.includes(Buffer.from('Public QR fixture')), false)
    }
  })
}

test('outbound PSBT QR decodes with the external UR and registry libraries without changing any bytes', () => {
  for (const scriptType of ['p2sh', 'p2sh-p2wsh', 'p2wsh']) {
    const f = fixture({ scriptType })
    f.psbt.addUnknownKeyValToGlobal({ key: Buffer.from('fc015401', 'hex'), value: Buffer.from('public global data') })
    f.psbt.addUnknownKeyValToInput(0, { key: Buffer.from('fc015402', 'hex'), value: Buffer.from('public input data') })
    f.psbt.addUnknownKeyValToOutput(0, { key: Buffer.from('fc015403', 'hex'), value: Buffer.from('public output data') })
    f.psbt.signInput(0, f.keys[0])
    const hex = f.psbt.toHex()
    const ur = externalDecode(multisigPsbtEncoder(hex))
    assert.equal(ur.type, 'crypto-psbt')
    const decodedHex = CryptoPSBT.fromCBOR(ur.cbor).getPSBT().toString('hex')
    assert.equal(decodedHex, hex)
    assert.equal(verifySignatures(parse(decodedHex)), true)
  }
})

test('inbound dynamic PSBT QR tolerates reverse order, duplicate frames, uppercase, and surrounding whitespace', () => {
  const f = fixture({ scriptType: 'p2sh', inputCount: 2 })
  const hex = f.psbt.toHex()
  const frames = externalEncoder(hex).encodeWhole().reverse()
  assert.ok(frames.length > 2)
  const decoder = new MultisigPsbtQrDecoder()
  const first = decoder.receive(` \n${frames[0].toUpperCase()} \n`)
  assert.ok(first.progress >= 0 && first.progress < 1)
  assert.equal(first.psbtHex, undefined)
  assert.deepEqual(decoder.receive(frames[0]), first)
  let result
  for (const frame of frames.slice(1)) result = decoder.receive(frame)
  assert.deepEqual(result, { progress: 1, psbtHex: hex })
  assert.deepEqual(decoder.receive(frames[0]), result)
})

test('fountain redundancy reconstructs a PSBT despite dropped original frames', () => {
  const f = fixture({ inputCount: 2 })
  f.psbt.signAllInputs(f.keys[1])
  const hex = f.psbt.toHex()
  const encoder = externalEncoder(hex, 60)
  const originals = encoder.encodeWhole()
  assert.ok(originals.length > 4)
  const decoder = new MultisigPsbtQrDecoder()
  let result
  // Intentionally never provide the first original frame or every third frame.
  for (let index = originals.length - 1; index > 0; index--) {
    if (index % 3 !== 0) result = decoder.receive(originals[index])
  }
  assert.equal(result.psbtHex, undefined)
  for (let index = 0; index < originals.length * 20 && !result.psbtHex; index++) result = decoder.receive(encoder.nextPart())
  assert.deepEqual(result, { progress: 1, psbtHex: hex })
  assert.equal(verifySignatures(parse(result.psbtHex)), true)
})

test('the inbound and outbound QR roundtrip preserves partial signatures and all unknown fields', () => {
  const f = fixture()
  f.psbt.addUnknownKeyValToGlobal({ key: Buffer.from('fc015411', 'hex'), value: Buffer.from('global preservation') })
  f.psbt.addUnknownKeyValToInput(0, { key: Buffer.from('fc015412', 'hex'), value: Buffer.from('input preservation') })
  f.psbt.addUnknownKeyValToOutput(0, { key: Buffer.from('fc015413', 'hex'), value: Buffer.from('output preservation') })
  f.psbt.signInput(0, f.keys[1])
  const original = f.psbt.toHex()
  const decoder = new MultisigPsbtQrDecoder()
  let result
  for (const frame of externalEncoder(original).encodeWhole().reverse()) result = decoder.receive(frame)
  assert.equal(result.psbtHex, original)
  const ur = externalDecode(multisigPsbtEncoder(result.psbtHex))
  const returned = CryptoPSBT.fromCBOR(ur.cbor).getPSBT().toString('hex')
  assert.equal(returned, original)
  assert.deepEqual(parse(returned).data.inputs[0].partialSig, f.psbt.data.inputs[0].partialSig)
  assert.equal(verifySignatures(parse(returned)), true)
})

test('dynamic frames from different transactions cannot be mixed in one scan', () => {
  const first = externalEncoder(fixture().psbt.toHex())
  const second = externalEncoder(fixture({ outputAmount: 98000 }).psbt.toHex())
  const decoder = new MultisigPsbtQrDecoder()
  decoder.receive(first.nextPart())
  assert.throws(() => decoder.receive(second.nextPart()), /different|mixed|new scan/i)
})

test('a completed single-frame scan accepts only its duplicate and rejects another transaction or a new multipart sequence', () => {
  const first = fixture().psbt.toHex()
  const second = fixture({ outputAmount: 98000 }).psbt.toHex()
  const frame = singleFrame(first)
  const decoder = new MultisigPsbtQrDecoder()
  assert.deepEqual(decoder.receive(frame), { progress: 1, psbtHex: first })
  assert.deepEqual(decoder.receive(frame), { progress: 1, psbtHex: first })
  assert.throws(() => decoder.receive(singleFrame(second)), /new scan|different|completed/i)
  assert.throws(() => decoder.receive(externalEncoder(second).nextPart()), /new scan|different|completed/i)
})

test('a single-frame PSBT cannot replace a partially scanned dynamic sequence', () => {
  const first = fixture().psbt.toHex()
  const decoder = new MultisigPsbtQrDecoder()
  decoder.receive(externalEncoder(first).nextPart())
  assert.throws(() => decoder.receive(singleFrame(first)), /mixed|sequence/i)
})

test('a QR for another UR registry type is rejected', () => {
  const wrong = UREncoder.encodeSinglePart(new UR(Buffer.from([0x41, 0x01]), 'bytes'))
  assert.throws(() => new MultisigPsbtQrDecoder().receive(wrong), /PSBT|Sparrow/i)
})

test('invalid QR encodings and payload lengths fail without returning a transaction', () => {
  for (const frame of ['', 'not a UR', 'ur:crypto-psbt/invalid', 'ur:crypto-psbt/' + 'a'.repeat(12001)]) {
    assert.throws(() => new MultisigPsbtQrDecoder().receive(frame))
  }
  for (const hex of ['', 'a', 'zz', '00'.repeat(1024 * 1024 + 1)]) assert.throws(() => multisigPsbtEncoder(hex))
})

test('fountain metadata is bounded before untrusted sequence allocation', () => {
  const attacks = [
    { seqLength: 4097, messageLength: 40970 },
    { seqLength: 2, messageLength: 1024 * 1024 + 1025 },
    { messageLength: 0 },
    { messageLength: -1 },
    { messageLength: 21 },
    { messageLength: 10 },
    { seqNum: 1, uriSequence: 2 },
    { seqNum: 1, uriSequence: 4294967297 },
    { seqNum: 1, uriSequence: '01' },
    { seqNum: 1, uriSequence: '1e0' },
    { uriLength: 3 },
    { checksum: -1 },
    { checksum: 4294967296 }
  ]
  for (const attack of attacks) {
    assert.throws(() => new MultisigPsbtQrDecoder().receive(forgedFrame(attack)), undefined, JSON.stringify(attack))
  }
})

test('a damaged QR frame fails its bytewords checksum', () => {
  const frame = externalEncoder(fixture().psbt.toHex()).nextPart()
  const damaged = frame.slice(0, -2) + (frame.endsWith('ae') ? 'ao' : 'ae')
  assert.throws(() => new MultisigPsbtQrDecoder().receive(damaged))
})
