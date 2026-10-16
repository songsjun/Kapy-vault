const assert = require('node:assert/strict')
const test = require('node:test')
const load = require('./helpers/source-loader.cjs')()
const { deriveMultisigCosigner, inspectMultisigPsbt, signMultisigPsbt } =
  load('src/app/services/bitcoin-multisig/bitcoin-multisig.ts')
const { bitcoin, MNEMONICS, networks, accountPath, rootFor, fixture, parse, verifySignatures, signOther } =
  require('./helpers/multisig-fixtures.cjs')

const sign = (f, hex = f.psbt.toHex(), mnemonic = f.mnemonic, passphrase = f.passphrase) =>
  signMultisigPsbt(hex, mnemonic, passphrase, f.network)
const inspect = (f, hex = f.psbt.toHex()) => inspectMultisigPsbt(hex, f.network)
const inputSignatures = (psbt) => psbt.data.inputs.map((input) =>
  (input.partialSig ?? []).map(({ pubkey, signature }) => [pubkey.toString('hex'), signature.toString('hex')]).sort())

for (const scriptType of ['p2sh', 'p2sh-p2wsh', 'p2wsh']) {
  test(`${scriptType}: one Vault signature and an independent second signer finalize a 2-of-3 transaction`, async () => {
    const f = fixture({ scriptType, inputCount: 2 })
    const originalHex = f.psbt.toHex()
    const unsignedTx = f.psbt.data.globalMap.unsignedTx.toBuffer()
    const review = inspect(f)
    assert.equal(review.inputs.length, 2)
    for (const [index, input] of review.inputs.entries()) {
      assert.equal(input.index, index)
      assert.equal(input.scriptType, scriptType)
      assert.equal(input.threshold, 2)
      assert.equal(input.keyCount, 3)
      assert.equal(input.amount, 100000)
    }
    assert.equal(review.outputs.length, 1)
    assert.equal(review.outputs[0].address, f.destination.address)
    assert.equal(review.outputs[0].amount, 199000)
    assert.equal(review.outputs[0].scriptHex, f.destination.output.toString('hex'))
    assert.equal(review.fee, 1000)
    assert.equal(review.feeVerified, scriptType === 'p2sh')
    assert.equal(review.transactionId, f.psbt.data.globalMap.unsignedTx.tx.getId())

    const signed = await sign(f)
    assert.equal(signed.addedSignatures, 2)
    assert.equal(signed.alreadySignedInputs, 0)
    assert.equal(signed.inputCount, 2)
    assert.equal(f.psbt.toHex(), originalHex, 'the caller-owned PSBT remains unchanged')
    const partial = parse(signed.psbtHex)
    assert.deepEqual(partial.data.globalMap.unsignedTx.toBuffer(), unsignedTx)
    assert.ok(partial.data.inputs.every((input) => input.partialSig.length === 1))
    assert.equal(verifySignatures(partial), true)

    const complete = signOther(f, signed.psbtHex)
    assert.equal(verifySignatures(complete), true)
    complete.finalizeAllInputs()
    const transaction = complete.extractTransaction()
    assert.equal(transaction.ins.length, 2)
    assert.equal(transaction.outs[0].value, 199000)
    assert.equal(complete.getFee(), 1000)
    for (const input of transaction.ins) {
      if (scriptType === 'p2sh') assert.ok(input.script.length > 0)
      else assert.equal(input.witness.length, 4, 'CHECKMULTISIG dummy, two signatures, and witnessScript')
    }
  })

  test(`${scriptType}: preserves another signer, all unknown PSBT fields, and transaction identity`, async () => {
    const f = fixture({ scriptType })
    f.psbt.addUnknownKeyValToGlobal({ key: Buffer.from('fc015401', 'hex'), value: Buffer.from('public-global') })
    f.psbt.addUnknownKeyValToInput(0, { key: Buffer.from('fc015402', 'hex'), value: Buffer.from('public-input') })
    f.psbt.addUnknownKeyValToOutput(0, { key: Buffer.from('fc015403', 'hex'), value: Buffer.from('public-output') })
    const alreadyPartial = signOther(f, f.psbt.toHex())
    const previous = inputSignatures(alreadyPartial)
    const result = await sign(f, alreadyPartial.toHex())
    const signed = parse(result.psbtHex)
    assert.equal(result.addedSignatures, 1)
    assert.equal(result.alreadySignedInputs, 0)
    assert.ok(inputSignatures(signed)[0].some((signature) => JSON.stringify(signature) === JSON.stringify(previous[0][0])))
    assert.deepEqual(signed.data.globalMap.unknownKeyVals, alreadyPartial.data.globalMap.unknownKeyVals)
    assert.deepEqual(signed.data.inputs[0].unknownKeyVals, alreadyPartial.data.inputs[0].unknownKeyVals)
    assert.deepEqual(signed.data.outputs[0].unknownKeyVals, alreadyPartial.data.outputs[0].unknownKeyVals)
    assert.deepEqual(signed.data.globalMap.unsignedTx.toBuffer(), alreadyPartial.data.globalMap.unsignedTx.toBuffer())
    assert.equal(verifySignatures(signed), true)
    signed.finalizeAllInputs()
    assert.equal(signed.extractTransaction().outs[0].value, 99000)
  })

  test(`${scriptType}: signing twice is idempotent and reports the existing valid local signature`, async () => {
    const f = fixture({ scriptType })
    const first = await sign(f)
    const second = await sign(f, first.psbtHex)
    assert.equal(second.addedSignatures, 0)
    assert.equal(second.alreadySignedInputs, 1)
    assert.equal(second.psbtHex, first.psbtHex)
  })
}

test('a single PSBT can independently sign and finalize mixed P2SH, nested SegWit, and native SegWit multisig inputs', async () => {
  const types = ['p2sh', 'p2sh-p2wsh', 'p2wsh']
  const sources = types.map((scriptType) => fixture({ scriptType }))
  assert.equal(new Set(sources.map((source) => source.fundings[0].getId())).size, 3)
  const mixed = new bitcoin.Psbt({ network: networks.testnet })
  for (const source of sources) {
    mixed.addInput({ hash: source.fundings[0].getId(), index: 0, ...source.psbt.data.inputs[0] })
  }
  mixed.addOutput({ address: sources[0].destination.address, value: 299000 })
  const review = inspectMultisigPsbt(mixed.toHex(), 'testnet')
  assert.deepEqual(review.inputs.map((input) => input.scriptType), types)
  assert.ok(review.inputs.every((input) => input.threshold === 2 && input.keyCount === 3 && input.amount === 100000))
  assert.equal(review.fee, 1000)
  const signed = await signMultisigPsbt(mixed.toHex(), MNEMONICS[0], '', 'testnet')
  assert.equal(signed.addedSignatures, 3)
  assert.equal(signed.alreadySignedInputs, 0)
  assert.equal(signed.inputCount, 3)
  const complete = parse(signed.psbtHex)
  assert.ok(complete.data.inputs.every((input) => input.partialSig.length === 1))
  assert.equal(verifySignatures(complete), true)
  for (const [index, source] of sources.entries()) complete.signInput(index, source.keys[1])
  assert.equal(verifySignatures(complete), true)
  complete.finalizeAllInputs()
  const transaction = complete.extractTransaction()
  assert.equal(transaction.ins.length, 3)
  assert.ok(transaction.ins[0].script.length > 0)
  assert.equal(transaction.ins[1].witness.length, 4)
  assert.equal(transaction.ins[2].witness.length, 4)
  assert.equal(transaction.outs[0].value, 299000)
  assert.equal(complete.getFee(), 1000)
})

test('cosigner exports use standard public BIP45/BIP48 origins and correct xpub network versions', async () => {
  for (const network of ['mainnet', 'testnet', 'signet', 'regtest']) {
    for (const scriptType of ['p2sh', 'p2sh-p2wsh', 'p2wsh']) {
      const passphrase = 'Public test passphrase'
      const result = await deriveMultisigCosigner(MNEMONICS[0], passphrase, { network, scriptType, account: 0 })
      const root = rootFor(MNEMONICS[0], passphrase, network)
      assert.equal(result.derivationPath, accountPath(scriptType, network))
      assert.equal(result.masterFingerprint, root.fingerprint.toString('hex'))
      assert.equal(result.xpub, root.derivePath(result.derivationPath).neutered().toBase58())
      assert.equal(result.network, network)
      assert.equal(result.scriptType, scriptType)
      assert.match(result.xpub, network === 'mainnet' ? /^xpub/ : /^tpub/)
      assert.equal(JSON.stringify(result).includes(MNEMONICS[0]), false)
      assert.equal(JSON.stringify(result).includes(passphrase), false)
      assert.equal(JSON.stringify(result).includes('prv'), false)
    }
  }
})

test('nonzero BIP48 accounts derive and sign; BIP45 does not silently accept a different account', async () => {
  for (const scriptType of ['p2sh-p2wsh', 'p2wsh']) {
    const f = fixture({ scriptType, account: 7, branch: 1, derivationIndex: 93 })
    const exported = await deriveMultisigCosigner(f.mnemonic, '', { scriptType, account: 7, network: f.network })
    assert.equal(exported.derivationPath, accountPath(scriptType, f.network, 7))
    assert.equal((await sign(f)).addedSignatures, 1)
  }
  await assert.rejects(deriveMultisigCosigner(MNEMONICS[0], '', { scriptType: 'p2sh', account: 1, network: 'testnet' }))
})

test('complete BIP45 cosigner/change/index origins sign and finalize', async () => {
  const f = fixture({ scriptType: 'p2sh', legacyCosignerIndex: 4, branch: 1, derivationIndex: 9 })
  assert.equal(f.path, "m/45'/4/1/9")
  const signed = await sign(f)
  const complete = signOther(f, signed.psbtHex)
  assert.equal(verifySignatures(complete), true)
  complete.finalizeAllInputs()
  assert.equal(complete.extractTransaction().outs[0].value, 99000)
})

test('mainnet, testnet, signet, and regtest use correct address rendering and signature origins', async () => {
  for (const network of ['mainnet', 'testnet', 'signet', 'regtest']) {
    const f = fixture({ network })
    assert.equal(inspect(f).outputs[0].address, f.destination.address)
    const signed = await sign(f)
    const complete = signOther(f, signed.psbtHex)
    assert.equal(verifySignatures(complete), true)
    complete.finalizeAllInputs()
    assert.equal(complete.getFee(), 1000)
  }
})

test('the threshold is read from the script instead of fixed to 2-of-3', async () => {
  const one = fixture({ threshold: 1 })
  const signedOne = await sign(one)
  assert.equal(inspect(one).inputs[0].threshold, 1)
  const completeOne = parse(signedOne.psbtHex)
  completeOne.finalizeAllInputs()
  assert.equal(completeOne.extractTransaction().outs[0].value, 99000)
  const three = fixture({ threshold: 3 })
  const signedThree = await sign(three)
  assert.equal(inspect(three).inputs[0].threshold, 3)
  const twice = signOther(three, signedThree.psbtHex)
  assert.throws(() => twice.finalizeAllInputs())
  const completeThree = signOther(three, twice.toHex(), 2)
  assert.equal(verifySignatures(completeThree), true)
  completeThree.finalizeAllInputs()
  assert.equal(completeThree.extractTransaction().outs[0].value, 99000)
})

test('raw script outputs and zero-value OP_RETURN outputs remain visible in review', () => {
  const f = fixture()
  const script = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from('public fixture')])
  f.psbt.addOutput({ script, value: 0 })
  const review = inspect(f)
  assert.equal(review.outputs.length, 2)
  assert.equal(review.outputs[1].index, 1)
  assert.equal(review.outputs[1].amount, 0)
  assert.equal(review.outputs[1].address, undefined)
  assert.equal(review.outputs[1].scriptHex, script.toString('hex'))
  assert.equal(review.fee, 1000)
})

test('a foreign seed or a different BIP39 passphrase cannot produce a successful zero-signature result', async () => {
  const f = fixture({ passphrase: 'Public exact wallet passphrase' })
  await assert.rejects(sign(f, f.psbt.toHex(), MNEMONICS[3]))
  await assert.rejects(sign(f, f.psbt.toHex(), f.mnemonic, 'Public other wallet passphrase'))
  await assert.rejects(sign(f, f.psbt.toHex(), f.mnemonic, ''))
  assert.equal((await sign(f)).addedSignatures, 1)
})

test('matching fingerprint without the exact derived pubkey does not authorize signing', async () => {
  const f = fixture()
  f.psbt.data.inputs[0].bip32Derivation[0].path = `${f.originPath}/0/6`
  await assert.rejects(sign(f))
})

test('full previous transactions authenticate SegWit fee amounts; witness-only amounts are marked unverified', () => {
  for (const scriptType of ['p2sh-p2wsh', 'p2wsh']) {
    assert.equal(inspect(fixture({ scriptType })).feeVerified, false)
    const full = inspect(fixture({ scriptType, includeNonWitness: true }))
    assert.equal(full.feeVerified, true)
    assert.equal(full.fee, 1000)
  }
})

test('rejects a false previous transaction hash, invalid vout, and conflicting dual UTXO data', async () => {
  const mutations = [
    (f) => { const altered = bitcoin.Transaction.fromBuffer(f.psbt.data.inputs[0].nonWitnessUtxo); altered.locktime++; f.psbt.data.inputs[0].nonWitnessUtxo = altered.toBuffer() },
    (f) => { f.psbt.data.globalMap.unsignedTx.tx.ins[0].index = 2 },
    (f) => { f.psbt.data.inputs[0].witnessUtxo.value++ },
    (f) => { f.psbt.data.inputs[0].witnessUtxo.script = Buffer.from('0014' + '11'.repeat(20), 'hex') }
  ]
  for (const mutate of mutations) {
    const f = fixture({ includeNonWitness: true })
    mutate(f)
    assert.throws(() => inspect(f))
    await assert.rejects(sign(f))
  }
})

test('rejects missing scripts and wrapper hashes that do not commit to the actual multisig script', async () => {
  for (const scriptType of ['p2sh', 'p2sh-p2wsh', 'p2wsh']) {
    const missing = fixture({ scriptType })
    delete missing.psbt.data.inputs[0][scriptType === 'p2sh' ? 'redeemScript' : 'witnessScript']
    assert.throws(() => inspect(missing))
    await assert.rejects(sign(missing))
    const wrong = fixture({ scriptType })
    const replacement = bitcoin.payments.p2ms({ m: 1, pubkeys: [wrong.keys[0].publicKey], network: networks.testnet }).output
    wrong.psbt.data.inputs[0][scriptType === 'p2sh' ? 'redeemScript' : 'witnessScript'] = replacement
    assert.throws(() => inspect(wrong))
    await assert.rejects(sign(wrong))
  }
  const nested = fixture({ scriptType: 'p2sh-p2wsh' })
  nested.psbt.data.inputs[0].redeemScript = Buffer.from('0020' + '22'.repeat(32), 'hex')
  assert.throws(() => inspect(nested))
  await assert.rejects(sign(nested))
})

test('legacy inputs require full previous transactions, while negative fees and duplicate outpoints are rejected', async () => {
  // bitcoinjs caches nonWitnessUtxo behind an accessor. Omit it during fixture
  // creation instead of deleting the accessor and accidentally restoring it.
  const missingLegacy = fixture({ scriptType: 'p2sh', includeNonWitness: false })
  const negative = fixture({ outputAmount: 100001 })
  const duplicate = fixture({ inputCount: 2 })
  duplicate.psbt.data.globalMap.unsignedTx.tx.ins[1].hash = Buffer.from(duplicate.psbt.data.globalMap.unsignedTx.tx.ins[0].hash)
  duplicate.psbt.data.globalMap.unsignedTx.tx.ins[1].index = 0
  for (const f of [missingLegacy, negative, duplicate]) {
    assert.throws(() => inspect(f))
    await assert.rejects(sign(f))
  }
})

test('only SIGHASH_ALL is accepted before approval or signing', async () => {
  for (const sighashType of [bitcoin.Transaction.SIGHASH_NONE, bitcoin.Transaction.SIGHASH_SINGLE,
    bitcoin.Transaction.SIGHASH_ALL | bitcoin.Transaction.SIGHASH_ANYONECANPAY]) {
    const f = fixture()
    f.psbt.updateInput(0, { sighashType })
    assert.throws(() => inspect(f))
    await assert.rejects(sign(f))
  }
  const explicitAll = fixture()
  explicitAll.psbt.updateInput(0, { sighashType: bitcoin.Transaction.SIGHASH_ALL })
  assert.equal((await sign(explicitAll)).addedSignatures, 1)
})

test('Taproot and single-signature inputs are not accidentally routed through the multisig signer', async () => {
  for (const script of [Buffer.from('5120' + '11'.repeat(32), 'hex'), Buffer.from('0014' + '11'.repeat(20), 'hex')]) {
    const f = fixture()
    f.psbt.data.inputs[0].witnessUtxo.script = script
    delete f.psbt.data.inputs[0].witnessScript
    assert.throws(() => inspect(f))
    await assert.rejects(sign(f))
  }
})

test('an invalid existing local signature is rejected instead of reported as already signed', async () => {
  const f = fixture()
  const first = await sign(f)
  const psbt = parse(first.psbtHex)
  const localSignature = psbt.data.inputs[0].partialSig[0]
  const decoded = bitcoin.script.signature.decode(localSignature.signature)
  decoded.signature[0] ^= 1
  localSignature.signature = bitcoin.script.signature.encode(decoded.signature, decoded.hashType)
  await assert.rejects(sign(f, psbt.toHex()))
})

test('duplicate script keys and multiple matching local script keys are rejected', async () => {
  const duplicate = fixture()
  const duplicatedScript = bitcoin.payments.p2ms({ m: 2,
    pubkeys: [duplicate.keys[0].publicKey, duplicate.keys[0].publicKey, duplicate.keys[1].publicKey], network: networks.testnet })
  duplicate.psbt.data.inputs[0].witnessScript = duplicatedScript.output
  duplicate.psbt.data.inputs[0].witnessUtxo.script = bitcoin.payments.p2wsh({ redeem: duplicatedScript, network: networks.testnet }).output
  assert.throws(() => inspect(duplicate))
  await assert.rejects(sign(duplicate))

  const multiple = fixture()
  const secondPath = `${multiple.originPath}/0/6`
  const secondLocalKey = multiple.roots[0].derivePath(secondPath)
  const multipleScript = bitcoin.payments.p2ms({ m: 2,
    pubkeys: [multiple.keys[0].publicKey, secondLocalKey.publicKey, multiple.keys[1].publicKey], network: networks.testnet })
  multiple.psbt.data.inputs[0].witnessScript = multipleScript.output
  multiple.psbt.data.inputs[0].witnessUtxo.script = bitcoin.payments.p2wsh({ redeem: multipleScript, network: networks.testnet }).output
  multiple.psbt.data.inputs[0].bip32Derivation = [multiple.psbt.data.inputs[0].bip32Derivation[0], {
    pubkey: secondLocalKey.publicKey, masterFingerprint: multiple.roots[0].fingerprint, path: secondPath
  }, multiple.psbt.data.inputs[0].bip32Derivation[1]]
  assert.equal(inspect(multiple).inputs[0].keyCount, 3)
  await assert.rejects(sign(multiple))
})

test('finalized PSBTs are rejected and cannot be mistaken for a fresh partial-signature request', async () => {
  const f = fixture()
  const signed = await sign(f)
  const finalized = signOther(f, signed.psbtHex)
  finalized.finalizeAllInputs()
  assert.throws(() => inspect(f, finalized.toHex()))
  await assert.rejects(sign(f, finalized.toHex()))
})

test('trailing maps, PSBT v2 declarations, and oversized payloads are rejected', async () => {
  const f = fixture()
  const version2 = fixture()
  const version = Buffer.alloc(4)
  version.writeUInt32LE(2)
  version2.psbt.addUnknownKeyValToGlobal({ key: Buffer.from([0xfb]), value: version })
  for (const hex of [f.psbt.toHex() + '00', version2.psbt.toHex(), '70736274ff' + '00'.repeat(512 * 1024)]) {
    assert.throws(() => inspect(f, hex))
    await assert.rejects(sign(f, hex))
  }
})

test('the 65th input is rejected before a signing result is returned', async () => {
  const f = fixture({ inputCount: 65 })
  assert.throws(() => inspect(f))
  await assert.rejects(sign(f))
})

test('rejects nonstandard origin paths and a path for the wrong Bitcoin network', async () => {
  for (const path of ["m/48'/1'/0'/1'/0/5", "m/48'/0'/0'/2'/0/5", "m/48'/1'/0'/2'/2/5", "m/48'/1'/0'/2'/0/5'", "m/48'/1'/0'/2'/0/5/7"]) {
    const f = fixture()
    f.psbt.data.inputs[0].bip32Derivation[0].path = path
    await assert.rejects(sign(f))
  }
})

test('malformed PSBT input and unsupported cosigner options fail without key material in errors', async () => {
  for (const hex of ['', 'not hex', '70736274ff', '00']) {
    assert.throws(() => inspectMultisigPsbt(hex, 'testnet'))
    await assert.rejects(signMultisigPsbt(hex, MNEMONICS[0], '', 'testnet'))
  }
  for (const options of [
    { network: 'unknown', scriptType: 'p2wsh', account: 0 },
    { network: 'testnet', scriptType: 'p2tr', account: 0 },
    { network: 'testnet', scriptType: 'p2wsh', account: -1 },
    { network: 'testnet', scriptType: 'p2wsh', account: 0x80000000 }
  ]) {
    await assert.rejects(deriveMultisigCosigner(MNEMONICS[0], '', options), (error) => {
      assert.equal(String(error).includes(MNEMONICS[0]), false)
      return true
    })
  }
})
