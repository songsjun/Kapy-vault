import { Buffer } from 'buffer'
import { BIP32Factory, BIP32Interface } from '@airgap/coinlib-core/dependencies/src/bip32-5.0.1/src/index'
import * as ecc from '@airgap/coinlib-core/dependencies/src/@bitcoinerlab/secp256k1-1.2.0/src/index'
import * as bitcoin from '@airgap/coinlib-core/dependencies/src/bitcoinjs-lib-6.1.7/src/index'
import { mnemonicToSeed, validateMnemonic, wordlists } from 'bip39'

export type BitcoinMultisigNetwork = 'mainnet' | 'testnet' | 'signet' | 'regtest'
export type BitcoinMultisigScript = 'p2sh' | 'p2sh-p2wsh' | 'p2wsh'

export interface BitcoinMultisigCosigner {
  xpub: string
  masterFingerprint: string
  derivationPath: string
  network: BitcoinMultisigNetwork
  scriptType: BitcoinMultisigScript
}

export interface BitcoinMultisigInput {
  index: number
  scriptType: BitcoinMultisigScript
  threshold: number
  keyCount: number
  /** Satoshis. Unverified when the input only supplies witnessUtxo. */
  amount: number
}

export interface BitcoinMultisigOutput {
  index: number
  address?: string
  scriptHex: string
  /** Satoshis. No output is classified as change. */
  amount: number
}

export interface BitcoinMultisigReview {
  network: BitcoinMultisigNetwork
  inputs: BitcoinMultisigInput[]
  outputs: BitcoinMultisigOutput[]
  fee: number
  /** True only when every input includes a verified full previous transaction. */
  feeVerified: boolean
  /** ID of the unsigned transaction, not the eventual legacy transaction ID. */
  transactionId: string
  version: number
  locktime: number
}

export interface BitcoinMultisigSignResult {
  psbtHex: string
  addedSignatures: number
  alreadySignedInputs: number
  inputCount: number
}

// These limits apply before parsing or deriving keys. A scanned document must not
// cause unbounded allocations, key derivation, or signature verification.
const MAX_PSBT_BYTES = 512 * 1024
const MAX_INPUTS = 64
const MAX_OUTPUTS = 128
const MAX_KEYS = 16
const MAX_MAP_ENTRIES = 128
const MAX_MONEY = 21000000 * 100000000
const HARDENED = 0x80000000
const bip32 = BIP32Factory(ecc)

interface CheckedInput extends BitcoinMultisigInput {
  signingScript: Buffer
  publicKeys: Buffer[]
  fullPreviousTransaction: boolean
}

interface CheckedPsbt {
  psbt: bitcoin.Psbt
  transaction: bitcoin.Transaction
  unsignedBytes: Buffer
  inputs: CheckedInput[]
  review: BitcoinMultisigReview
}

function networkParameters(network: BitcoinMultisigNetwork): bitcoin.Network {
  switch (network) {
    case 'mainnet': return bitcoin.networks.bitcoin
    case 'testnet':
    case 'signet': return bitcoin.networks.testnet
    case 'regtest': return bitcoin.networks.regtest
    default: throw new Error('Unsupported Bitcoin network')
  }
}

function fail(message: string): never {
  throw new Error(message)
}

function amount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MONEY) {
    fail('Invalid Bitcoin amount')
  }
  return value
}

function sumAmounts(values: number[]): number {
  return values.reduce((total, value) => amount(total + amount(value)), 0)
}

/** Scan maps before bitcoinjs allocates parsed PSBT objects. */
function checkEnvelope(bytes: Buffer): number {
  if (bytes.length > MAX_PSBT_BYTES || !bytes.subarray(0, 5).equals(Buffer.from('70736274ff', 'hex'))) {
    fail('Invalid or oversized PSBT')
  }
  let offset = 5
  let mapCount = 0
  let inputCount = 0
  let outputCount = 0
  const readSize = (): number => {
    if (offset >= bytes.length) return fail('Truncated PSBT')
    const first = bytes[offset++]
    if (first < 0xfd) return first
    const length = first === 0xfd ? 2 : first === 0xfe ? 4 : 8
    if (offset + length > bytes.length || length === 8) return fail('Invalid PSBT length')
    const value = length === 2 ? bytes.readUInt16LE(offset) : bytes.readUInt32LE(offset)
    offset += length
    if (value < (length === 2 ? 0xfd : 0x10000)) return fail('Non-canonical PSBT length')
    return value
  }
  while (offset < bytes.length) {
    if (++mapCount > 1 + MAX_INPUTS + MAX_OUTPUTS) fail('Too many PSBT maps')
    let entries = 0
    let derivations = 0
    let signatures = 0
    while (true) {
      const keyLength = readSize()
      if (keyLength === 0) break
      if (++entries > MAX_MAP_ENTRIES || keyLength > 1024 || offset + keyLength > bytes.length) {
        fail('Oversized PSBT map')
      }
      const key = bytes.subarray(offset, offset + keyLength)
      offset += keyLength
      const valueLength = readSize()
      if (offset + valueLength > bytes.length) fail('Truncated PSBT value')
      if (mapCount === 1) {
        if (key.length === 1 && key[0] === 0x00) {
          const transaction = bitcoin.Transaction.fromBuffer(bytes.subarray(offset, offset + valueLength))
          inputCount = transaction.ins.length
          outputCount = transaction.outs.length
          if (inputCount < 1 || inputCount > MAX_INPUTS || outputCount < 1 || outputCount > MAX_OUTPUTS) {
            fail('PSBT exceeds supported input or output count')
          }
        }
        if (key[0] >= 0x02 && key[0] <= 0x06) fail('PSBT v2 is not supported')
        if (key[0] === 0xfb && (key.length !== 1 || valueLength !== 4 || bytes.readUInt32LE(offset) !== 0)) {
          fail('Only PSBT v0 is supported')
        }
        if (key[0] === 0x01 && (++derivations > 32 || valueLength > 36)) fail('Too many PSBT global keys')
      } else {
        const isInput = mapCount <= inputCount + 1
        if (key[0] === (isInput ? 0x06 : 0x02)) {
          if (++derivations > MAX_KEYS || valueLength > 36) fail('Too many or oversized PSBT derivations')
        }
        if (isInput && key[0] === 0x02 && ++signatures > MAX_KEYS) fail('Too many PSBT signatures')
      }
      offset += valueLength
    }
  }
  if (mapCount < 3 || mapCount !== 1 + inputCount + outputCount) fail('Invalid PSBT map count or trailing data')
  return mapCount
}

function parseMultisigScript(script: Buffer, index: number): { threshold: number; publicKeys: Buffer[] } {
  if (script.length > MAX_KEYS * 34 + 3) return fail(`Input ${index}: oversized multisig script`)
  const chunks = bitcoin.script.decompile(script)
  if (!chunks || chunks.length < 4 || !bitcoin.script.compile(chunks).equals(script)) {
    return fail(`Input ${index}: invalid multisig script`)
  }
  const first = chunks[0]
  const lastCount = chunks[chunks.length - 2]
  const threshold = typeof first === 'number' ? first - bitcoin.opcodes.OP_1 + 1 : 0
  const keyCount = typeof lastCount === 'number' ? lastCount - bitcoin.opcodes.OP_1 + 1 : 0
  if (threshold < 1 || keyCount < threshold || keyCount > MAX_KEYS || chunks.length !== keyCount + 3 ||
      chunks[chunks.length - 1] !== bitcoin.opcodes.OP_CHECKMULTISIG) {
    return fail(`Input ${index}: only standard CHECKMULTISIG scripts are supported`)
  }
  const publicKeys = chunks.slice(1, -2).map((key) => {
    if (!Buffer.isBuffer(key) || key.length !== 33 || !ecc.isPoint(key)) {
      return fail(`Input ${index}: invalid compressed public key`)
    }
    return key
  })
  if (new Set(publicKeys.map((key) => key.toString('hex'))).size !== keyCount) {
    fail(`Input ${index}: duplicate multisig public key`)
  }
  return { threshold, publicKeys }
}

function isP2sh(script: Buffer): boolean {
  return script.length === 23 && script[0] === bitcoin.opcodes.OP_HASH160 && script[1] === 20 &&
    script[22] === bitcoin.opcodes.OP_EQUAL
}

function isP2wsh(script: Buffer): boolean {
  return script.length === 34 && script[0] === 0 && script[1] === 32
}

function checkInput(psbt: bitcoin.Psbt, transaction: bitcoin.Transaction, index: number): CheckedInput {
  const input = psbt.data.inputs[index]
  const outpoint = transaction.ins[index]
  if (input.finalScriptSig !== undefined || input.finalScriptWitness !== undefined) {
    fail(`Input ${index}: finalized inputs are not supported`)
  }
  if (input.tapKeySig || input.tapScriptSig || input.tapLeafScript || input.tapBip32Derivation ||
      input.tapInternalKey || input.tapMerkleRoot ||
      input.unknownKeyVals?.some(({ key }) => key[0] >= 0x0e && key[0] <= 0x18)) {
    fail(`Input ${index}: Taproot and PSBT v2 inputs are not supported`)
  }
  if (input.sighashType !== undefined && input.sighashType !== bitcoin.Transaction.SIGHASH_ALL) {
    fail(`Input ${index}: only SIGHASH_ALL is supported`)
  }
  if ((input.bip32Derivation?.length || 0) > MAX_KEYS || (input.partialSig?.length || 0) > MAX_KEYS) {
    fail(`Input ${index}: too many keys or signatures`)
  }
  let utxo = input.witnessUtxo
  if (input.nonWitnessUtxo) {
    const previous = bitcoin.Transaction.fromBuffer(input.nonWitnessUtxo)
    if (!previous.getHash().equals(outpoint.hash) || !previous.outs[outpoint.index]) {
      fail(`Input ${index}: previous transaction does not match outpoint`)
    }
    const previousOutput = previous.outs[outpoint.index]
    amount(previousOutput.value)
    if (utxo && (utxo.value !== previousOutput.value || !utxo.script.equals(previousOutput.script))) {
      fail(`Input ${index}: conflicting UTXO data`)
    }
    utxo = previousOutput
  }
  if (!utxo) return fail(`Input ${index}: missing UTXO data`)
  const value = amount(utxo.value)
  let scriptType: BitcoinMultisigScript
  let signingScript: Buffer
  if (isP2sh(utxo.script)) {
    const redeem = input.redeemScript
    if (!redeem || !bitcoin.crypto.hash160(redeem).equals(utxo.script.subarray(2, 22))) {
      return fail(`Input ${index}: redeem script does not match UTXO`)
    }
    if (isP2wsh(redeem)) {
      scriptType = 'p2sh-p2wsh'
      if (!input.witnessScript || !bitcoin.crypto.sha256(input.witnessScript).equals(redeem.subarray(2))) {
        return fail(`Input ${index}: witness script does not match redeem script`)
      }
      signingScript = input.witnessScript
    } else {
      scriptType = 'p2sh'
      if (input.witnessScript || !input.nonWitnessUtxo || redeem.length > 520) {
        return fail(`Input ${index}: legacy multisig requires a full previous transaction and a valid redeem script`)
      }
      signingScript = redeem
    }
  } else if (isP2wsh(utxo.script)) {
    scriptType = 'p2wsh'
    if (input.redeemScript || !input.witnessScript ||
        !bitcoin.crypto.sha256(input.witnessScript).equals(utxo.script.subarray(2))) {
      return fail(`Input ${index}: witness script does not match UTXO`)
    }
    signingScript = input.witnessScript
  } else {
    return fail(`Input ${index}: unsupported multisig script type`)
  }
  const multisig = parseMultisigScript(signingScript, index)
  const checked: CheckedInput = {
    index, scriptType, threshold: multisig.threshold, keyCount: multisig.publicKeys.length, amount: value,
    signingScript, publicKeys: multisig.publicKeys, fullPreviousTransaction: !!input.nonWitnessUtxo
  }
  const seenSignatures = new Set<string>()
  for (const partial of input.partialSig || []) {
    const keyHex = partial.pubkey.toString('hex')
    if (seenSignatures.has(keyHex) || !multisig.publicKeys.some((key) => key.equals(partial.pubkey))) {
      fail(`Input ${index}: signature key is not a unique script key`)
    }
    seenSignatures.add(keyHex)
    if (!validSignature(transaction, checked, partial.pubkey, partial.signature)) {
      fail(`Input ${index}: invalid existing signature or unsupported sighash`)
    }
  }
  return checked
}

function signatureHash(transaction: bitcoin.Transaction, input: CheckedInput): Buffer {
  return input.scriptType === 'p2sh'
    ? transaction.hashForSignature(input.index, input.signingScript, bitcoin.Transaction.SIGHASH_ALL)
    : transaction.hashForWitnessV0(input.index, input.signingScript, input.amount, bitcoin.Transaction.SIGHASH_ALL)
}

function validSignature(transaction: bitcoin.Transaction, input: CheckedInput, publicKey: Buffer, signature: Buffer): boolean {
  try {
    const decoded = bitcoin.script.signature.decode(signature)
    return decoded.hashType === bitcoin.Transaction.SIGHASH_ALL &&
      ecc.verify(signatureHash(transaction, input), publicKey, decoded.signature, true)
  } catch {
    return false
  }
}

function checkedPsbt(psbtHex: string, network: BitcoinMultisigNetwork): CheckedPsbt {
  const parameters = networkParameters(network)
  if (typeof psbtHex !== 'string' || psbtHex.length > MAX_PSBT_BYTES * 2 ||
      psbtHex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(psbtHex)) {
    return fail('PSBT must be bounded, non-empty hexadecimal data')
  }
  const bytes = Buffer.from(psbtHex, 'hex')
  const mapCount = checkEnvelope(bytes)
  const psbt = bitcoin.Psbt.fromBuffer(bytes, { network: parameters })
  const unsignedBytes = psbt.data.globalMap.unsignedTx.toBuffer()
  const transaction = bitcoin.Transaction.fromBuffer(unsignedBytes)
  if (transaction.ins.length < 1 || transaction.ins.length > MAX_INPUTS ||
      transaction.outs.length < 1 || transaction.outs.length > MAX_OUTPUTS) {
    fail('PSBT exceeds supported input or output count')
  }
  // The vendored BIP174 parser ignores trailing maps. Reject them so no input
  // data can silently disappear when the signed PSBT is serialized.
  if (mapCount !== 1 + transaction.ins.length + transaction.outs.length) fail('Unexpected PSBT maps or trailing data')
  if (transaction.ins.some((input) => input.script.length !== 0 || input.witness.length !== 0)) {
    fail('PSBT unsigned transaction must not contain unlocking data')
  }
  const outpoints = transaction.ins.map((input) => `${input.hash.toString('hex')}:${input.index}`)
  if (new Set(outpoints).size !== outpoints.length) fail('PSBT contains duplicate outpoints')
  const inputs = transaction.ins.map((_, index) => checkInput(psbt, transaction, index))
  const outputs = transaction.outs.map((output, index): BitcoinMultisigOutput => {
    let address: string | undefined
    try { address = bitcoin.address.fromOutputScript(output.script, parameters) } catch { /* Raw script is shown instead. */ }
    return { index, address, scriptHex: output.script.toString('hex'), amount: amount(output.value) }
  })
  const fee = amount(sumAmounts(inputs.map((input) => input.amount)) - sumAmounts(outputs.map((output) => output.amount)))
  const review: BitcoinMultisigReview = {
    network, inputs: inputs.map(({ index, scriptType, threshold, keyCount, amount: value }) =>
      ({ index, scriptType, threshold, keyCount, amount: value })),
    outputs, fee, feeVerified: inputs.every((input) => input.fullPreviousTransaction),
    transactionId: transaction.getId(), version: transaction.version, locktime: transaction.locktime
  }
  return { psbt, transaction, unsignedBytes, inputs, review }
}

function normalizePath(path: string, scriptType: BitcoinMultisigScript, network: BitcoinMultisigNetwork): string {
  if (typeof path !== 'string' || path.length > 128 || !/^m(?:\/(?:0|[1-9][0-9]*)(?:['hH])?)+$/.test(path)) {
    return fail('Invalid multisig key derivation path')
  }
  const parts = path.slice(2).split('/').map((part) => {
    const hardened = /['hH]$/.test(part)
    const index = Number(hardened ? part.slice(0, -1) : part)
    if (!Number.isSafeInteger(index) || index >= HARDENED) fail('Invalid derivation index')
    return { index, hardened }
  })
  const coin = network === 'mainnet' ? 0 : 1
  const prefixLength = scriptType === 'p2sh' ? 1 : 4
  if (scriptType === 'p2sh') {
    // Sparrow uses m/45'/change/index. Full BIP45 also adds a cosigner index.
    if ((parts.length !== 3 && parts.length !== 4) || parts[0].index !== 45 || !parts[0].hardened) {
      return fail('Legacy multisig requires a BIP45 derivation path')
    }
  } else if (parts.length !== 6 || parts[0].index !== 48 || parts[1].index !== coin ||
      parts[3].index !== (scriptType === 'p2wsh' ? 2 : 1) || parts.slice(0, 4).some((part) => !part.hardened)) {
    return fail('SegWit multisig requires a matching BIP48 derivation path')
  }
  if (parts.slice(prefixLength).some((part) => part.hardened) || parts[parts.length - 2].index > 1) {
    return fail('Multisig address path must use a public receive or change branch')
  }
  return 'm/' + parts.map((part) => `${part.index}${part.hardened ? "'" : ''}`).join('/')
}

async function rootFromMnemonic(mnemonic: string, passphrase: string, network: BitcoinMultisigNetwork): Promise<BIP32Interface> {
  const parameters = networkParameters(network)
  if (typeof mnemonic !== 'string' || mnemonic.length > 1024 || typeof passphrase !== 'string' || passphrase.length > 1024) {
    return fail('Invalid mnemonic or passphrase')
  }
  // Existing Vault secrets can use any installed BIP39 wordlist.
  if (!Object.keys(wordlists).some((language) => validateMnemonic(mnemonic, wordlists[language]))) {
    return fail('Invalid BIP39 mnemonic')
  }
  const seed = await mnemonicToSeed(mnemonic, passphrase)
  try { return bip32.fromSeed(seed, parameters) } finally { seed.fill(0) }
}

/** Export public cosigner information. Does not create or persist a wallet. */
export async function deriveMultisigCosigner(
  mnemonic: string,
  passphrase: string,
  options: { network: BitcoinMultisigNetwork; scriptType: BitcoinMultisigScript; account: number }
): Promise<BitcoinMultisigCosigner> {
  networkParameters(options.network)
  if (!Number.isInteger(options.account) || options.account < 0 || options.account >= HARDENED) {
    return fail('Invalid multisig account index')
  }
  let derivationPath: string
  if (options.scriptType === 'p2sh') {
    if (options.account !== 0) return fail('BIP45 legacy multisig does not have an account index')
    derivationPath = "m/45'"
  } else if (options.scriptType === 'p2sh-p2wsh' || options.scriptType === 'p2wsh') {
    const coin = options.network === 'mainnet' ? 0 : 1
    derivationPath = `m/48'/${coin}'/${options.account}'/${options.scriptType === 'p2wsh' ? 2 : 1}'`
  } else {
    return fail('Unsupported multisig script type')
  }
  const root = await rootFromMnemonic(mnemonic, passphrase, options.network)
  let child: BIP32Interface | undefined
  try {
    child = root.derivePath(derivationPath)
    return {
      xpub: child.neutered().toBase58(),
      masterFingerprint: Buffer.from(root.fingerprint).toString('hex'),
      derivationPath, network: options.network, scriptType: options.scriptType
    }
  } finally {
    child?.privateKey?.fill(0)
    root.privateKey?.fill(0)
  }
}

/** Inspect all outputs without making wallet ownership or change claims. */
export function inspectMultisigPsbt(psbtHex: string, network: BitcoinMultisigNetwork): BitcoinMultisigReview {
  return checkedPsbt(psbtHex, network).review
}

/** Append one local partial signature to every input, preserving the PSBT. */
export async function signMultisigPsbt(
  psbtHex: string,
  mnemonic: string,
  passphrase: string,
  network: BitcoinMultisigNetwork
): Promise<BitcoinMultisigSignResult> {
  const checked = checkedPsbt(psbtHex, network)
  const root = await rootFromMnemonic(mnemonic, passphrase, network)
  const derived = new Map<string, BIP32Interface>()
  derived.set('m', root)
  try {
    const derive = (path: string): BIP32Interface => {
      let node = root
      let prefix = 'm'
      for (const part of path.slice(2).split('/')) {
        prefix += '/' + part
        const existing = derived.get(prefix)
        if (existing) {
          node = existing
        } else {
          node = part.endsWith("'") ? node.deriveHardened(Number(part.slice(0, -1))) : node.derive(Number(part))
          derived.set(prefix, node)
        }
      }
      return node
    }
    // Resolve every input before mutation. A fingerprint is a hint, never proof
    // of ownership: the derived public key must match both the origin and script.
    const localKeys = checked.inputs.map((input) => {
      const origins = checked.psbt.data.inputs[input.index].bip32Derivation || []
      const own = new Map<string, BIP32Interface>()
      for (const origin of origins) {
        if (!input.publicKeys.some((key) => key.equals(origin.pubkey))) continue
        let path: string
        try {
          path = normalizePath(origin.path, input.scriptType, network)
        } catch {
          continue
        }
        const node = derive(path)
        if (Buffer.from(node.publicKey).equals(origin.pubkey)) own.set(origin.pubkey.toString('hex'), node)
      }
      if (own.size !== 1) {
        return fail(`Input ${input.index}: expected exactly one matching local multisig key`)
      }
      return Array.from(own.values())[0]
    })
    let addedSignatures = 0
    let alreadySignedInputs = 0
    for (const input of checked.inputs) {
      const node = localKeys[input.index]
      const publicKey = Buffer.from(node.publicKey)
      const previous = checked.psbt.data.inputs[input.index].partialSig?.find((signature) => signature.pubkey.equals(publicKey))
      if (previous) {
        // All existing signatures were validated while inspecting the PSBT.
        alreadySignedInputs++
      } else {
        const signature = bitcoin.script.signature.encode(
          Buffer.from(node.sign(signatureHash(checked.transaction, input))), bitcoin.Transaction.SIGHASH_ALL
        )
        if (!validSignature(checked.transaction, input, publicKey, signature)) fail(`Input ${input.index}: signature verification failed`)
        checked.psbt.updateInput(input.index, { partialSig: [{ pubkey: publicKey, signature }] })
        addedSignatures++
      }
    }
    const resultHex = checked.psbt.toHex()
    const result = checkedPsbt(resultHex, network)
    if (!result.unsignedBytes.equals(checked.unsignedBytes)) fail('Unsigned transaction changed during signing')
    for (const input of result.inputs) {
      const publicKey = Buffer.from(localKeys[input.index].publicKey)
      const signature = result.psbt.data.inputs[input.index].partialSig?.find((partial) => partial.pubkey.equals(publicKey))
      if (!signature || !validSignature(result.transaction, input, publicKey, signature.signature)) {
        fail(`Input ${input.index}: missing or invalid local signature`)
      }
    }
    return { psbtHex: resultHex, addedSignatures, alreadySignedInputs, inputCount: checked.inputs.length }
  } finally {
    // Best effort: JavaScript strings and library temporaries cannot be erased,
    // but these private node byte arrays must not outlive the operation.
    derived.forEach((node) => node.privateKey?.fill(0))
    derived.clear()
  }
}
