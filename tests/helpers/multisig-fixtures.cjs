const bitcoin = require('@airgap/coinlib-core/dependencies/src/bitcoinjs-lib-6.1.7/src')
// This older BIP32 implementation is deliberately separate from the production
// signer. All seeds below are public fixtures, derived from repeated hex digits.
const bip32 = require('@airgap/coinlib-core/dependencies/src/bip32-2.0.4/src')
const { entropyToMnemonic, mnemonicToSeedSync } = require('bip39')

const MNEMONICS = ['00', '11', '22', '33'].map((byte) => entropyToMnemonic(byte.repeat(16)))
const networks = {
  mainnet: bitcoin.networks.bitcoin,
  testnet: bitcoin.networks.testnet,
  signet: bitcoin.networks.testnet,
  regtest: bitcoin.networks.regtest
}

function accountPath(scriptType, network = 'testnet', account = 0) {
  if (scriptType === 'p2sh') return "m/45'"
  return `m/48'/${network === 'mainnet' ? 0 : 1}'/${account}'/${scriptType === 'p2sh-p2wsh' ? 1 : 2}'`
}

function rootFor(mnemonic, passphrase = '', network = 'testnet') {
  const seed = mnemonicToSeedSync(mnemonic, passphrase)
  try { return bip32.fromSeed(seed, networks[network]) } finally { seed.fill(0) }
}

function fixture({ scriptType = 'p2wsh', network = 'testnet', account = 0,
  inputCount = 1, includeNonWitness = scriptType === 'p2sh', passphrase = '',
  threshold = 2, derivationIndex = 5, branch = 0, legacyCosignerIndex, outputAmount } = {}) {
  const net = networks[network]
  const roots = MNEMONICS.slice(0, 3).map((mnemonic) => rootFor(mnemonic, passphrase, network))
  const originPath = accountPath(scriptType, network, account)
  const path = `${originPath}/${scriptType === 'p2sh' && legacyCosignerIndex !== undefined ? `${legacyCosignerIndex}/` : ''}${branch}/${derivationIndex}`
  const keys = roots.map((root) => root.derivePath(path))
  const pubkeys = keys.map((key) => key.publicKey).sort(Buffer.compare)
  const multisig = bitcoin.payments.p2ms({ m: threshold, pubkeys, network: net })
  const witness = bitcoin.payments.p2wsh({ redeem: multisig, network: net })
  const payment = scriptType === 'p2sh' ? bitcoin.payments.p2sh({ redeem: multisig, network: net }) :
    scriptType === 'p2sh-p2wsh' ? bitcoin.payments.p2sh({ redeem: witness, network: net }) : witness
  const psbt = new bitcoin.Psbt({ network: net })
  const fundings = []
  for (let index = 0; index < inputCount; index++) {
    const funding = new bitcoin.Transaction()
    funding.version = 2
    funding.addInput(Buffer.alloc(32, index + 1), index)
    funding.addOutput(payment.output, 100000)
    fundings.push(funding)
    psbt.addInput({
      hash: funding.getId(), index: 0,
      ...(includeNonWitness ? { nonWitnessUtxo: funding.toBuffer() } : {}),
      ...(scriptType !== 'p2sh' ? { witnessUtxo: { script: payment.output, value: 100000 }, witnessScript: multisig.output } : {}),
      ...(scriptType === 'p2sh' ? { redeemScript: multisig.output } : {}),
      ...(scriptType === 'p2sh-p2wsh' ? { redeemScript: witness.output } : {}),
      bip32Derivation: roots.map((root, index) => ({ masterFingerprint: root.fingerprint, path, pubkey: keys[index].publicKey }))
    })
  }
  const destination = bitcoin.payments.p2wpkh({ pubkey: rootFor(MNEMONICS[3], '', network).derivePath("m/84'/1'/0'/0/0").publicKey, network: net })
  psbt.addOutput({ address: destination.address, value: outputAmount ?? inputCount * 100000 - 1000 })
  return { psbt, network, scriptType, roots, keys, payment, multisig, witness, fundings,
    originPath, path, destination, mnemonic: MNEMONICS[0], passphrase }
}

function parse(hex, network = 'testnet') { return bitcoin.Psbt.fromHex(hex, { network: networks[network] }) }

function verifySignatures(psbt) {
  return psbt.validateSignaturesOfAllInputs((pubkey, hash, signature) =>
    bip32.fromPublicKey(pubkey, Buffer.alloc(32, 1)).verify(hash, signature))
}

function signOther(fixture, hex, signer = 1) {
  const psbt = parse(hex, fixture.network)
  for (let index = 0; index < psbt.inputCount; index++) psbt.signInput(index, fixture.keys[signer])
  return psbt
}

module.exports = { bitcoin, bip32, MNEMONICS, networks, accountPath, rootFor, fixture, parse, verifySignatures, signOther }
