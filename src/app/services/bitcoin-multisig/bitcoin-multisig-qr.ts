import { BIP32Factory } from '@airgap/coinlib-core/dependencies/src/bip32-5.0.1/src/index'
import * as ecc from '@airgap/coinlib-core/dependencies/src/@bitcoinerlab/secp256k1-1.2.0/src/index'
import * as bitcoin from '@airgap/coinlib-core/dependencies/src/bitcoinjs-lib-6.1.7/src/index'
import {
  CryptoAccount, CryptoCoinInfo, CryptoCoinInfoNetwork, CryptoCoinInfoType, CryptoHDKey,
  CryptoKeypath, CryptoOutput, CryptoPSBT, PathComponent, ScriptExpressions
} from '@keystonehq/bc-ur-registry'
import { URDecoder, UREncoder } from '@ngraveio/bc-ur'
import bytewords from '@ngraveio/bc-ur/dist/bytewords'
import { FountainEncoderPart } from '@ngraveio/bc-ur/dist/fountainEncoder'

import type { BitcoinMultisigCosigner } from './bitcoin-multisig'

const MAX_MESSAGE_BYTES = 1024 * 1024 + 1024
const MAX_FRAGMENT_CHARACTERS = 12000
const MAX_PARTS = 4096

/** A single cosigner, not a complete wallet descriptor. Sparrow supplies the quorum. */
export function multisigCosignerEncoder(cosigner: BitcoinMultisigCosigner): UREncoder {
  const network = cosigner.network === 'mainnet' ? bitcoin.networks.bitcoin : bitcoin.networks.testnet
  const node = BIP32Factory(ecc).fromBase58(cosigner.xpub, network)
  const path = cosigner.derivationPath.split('/').slice(1).map((part) => new PathComponent({
    index: parseInt(part, 10), hardened: /['hH]$/.test(part)
  }))
  const parentFingerprint = Buffer.alloc(4)
  parentFingerprint.writeUInt32BE(node.parentFingerprint, 0)
  const hdKey = new CryptoHDKey({
    isMaster: false,
    isPrivateKey: false,
    key: Buffer.from(node.publicKey),
    chainCode: Buffer.from(node.chainCode),
    useInfo: new CryptoCoinInfo(CryptoCoinInfoType.bitcoin,
      cosigner.network === 'mainnet' ? CryptoCoinInfoNetwork.mainnet : CryptoCoinInfoNetwork.testnet),
    origin: new CryptoKeypath(path, Buffer.from(cosigner.masterFingerprint, 'hex'), node.depth),
    parentFingerprint,
    name: 'AirGap Vault'
  })
  const expressions = cosigner.scriptType === 'p2sh'
    ? [ScriptExpressions.SCRIPT_HASH]
    : cosigner.scriptType === 'p2sh-p2wsh'
      ? [ScriptExpressions.SCRIPT_HASH, ScriptExpressions.WITNESS_SCRIPT_HASH]
      : [ScriptExpressions.WITNESS_SCRIPT_HASH]
  return new CryptoAccount(Buffer.from(cosigner.masterFingerprint, 'hex'), [new CryptoOutput(expressions, hdKey)])
    .toUREncoder(200)
}

export function multisigPsbtEncoder(psbtHex: string): UREncoder {
  if (!/^(?:[a-f0-9]{2})+$/i.test(psbtHex) || psbtHex.length > 2 * 1024 * 1024) {
    throw new Error('Invalid or oversized PSBT.')
  }
  return new CryptoPSBT(Buffer.from(psbtHex, 'hex')).toUREncoder(200)
}

/** One bounded UR session. A new scan must use a new instance. */
export class MultisigPsbtQrDecoder {
  private readonly decoder = new URDecoder()
  private readonly frames = new Set<string>()
  private message?: string
  private result?: string
  private characters = 0

  public receive(frame: string): { progress: number; psbtHex?: string } {
    if (typeof frame !== 'string' || frame.length > MAX_FRAGMENT_CHARACTERS) {
      throw new Error('The QR fragment is too large.')
    }
    const normalized = frame.trim().toLowerCase()
    if (this.result) {
      if (!this.frames.has(normalized)) throw new Error('This scan is complete. Start a new scan for another transaction.')
      return { progress: 1, psbtHex: this.result }
    }
    const [type, components] = URDecoder.parse(normalized)
    if (type !== 'crypto-psbt') throw new Error('Scan a Sparrow PSBT using UR encoding.')
    if (components.length === 2) {
      const sequenceText = /^([1-9][0-9]{0,9})-([1-9][0-9]{0,3})$/.exec(components[0])
      if (!sequenceText || Number(sequenceText[1]) > 0xffffffff || Number(sequenceText[2]) > MAX_PARTS) {
        throw new Error('Invalid QR sequence number.')
      }
      const [sequence, length] = URDecoder.parseSequenceComponent(components[0])
      if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(length) || length > MAX_PARTS) {
        throw new Error('The QR sequence is too large.')
      }
      // Check fountain metadata before the decoder allocates sequence indexes.
      const part = FountainEncoderPart.fromCBOR(bytewords.decode(components[1], bytewords.STYLES.MINIMAL))
      if (part.seqNum !== sequence || part.seqLength !== length ||
        !Number.isSafeInteger(part.messageLength) || part.messageLength < 1 || part.messageLength > MAX_MESSAGE_BYTES ||
        !Number.isSafeInteger(part.checksum) || part.checksum < 0 || part.checksum > 0xffffffff || part.fragment.length > 6000 ||
        part.messageLength > length * part.fragment.length || part.messageLength <= (length - 1) * part.fragment.length) {
        throw new Error('Invalid QR sequence metadata.')
      }
      const identity = `${length}:${part.messageLength}:${part.checksum}`
      if (this.message && this.message !== identity) throw new Error('QR fragments belong to different transactions. Start a new scan.')
      this.message = identity
    } else if (components.length !== 1 || this.message) {
      throw new Error('Invalid or mixed QR sequence.')
    }
    if (!this.frames.has(normalized)) {
      if (this.frames.size >= MAX_PARTS * 4 || this.characters + normalized.length > 8 * 1024 * 1024) {
        throw new Error('Too many QR fragments. Start a new scan.')
      }
      this.characters += normalized.length
      this.frames.add(normalized)
      this.decoder.receivePart(normalized)
    }
    if (this.decoder.isError()) throw new Error('The QR sequence could not be decoded.')
    if (this.decoder.isComplete() && this.decoder.isSuccess()) {
      const ur = this.decoder.resultUR()
      if (ur.cbor.length > MAX_MESSAGE_BYTES) throw new Error('The PSBT is too large.')
      const psbt = CryptoPSBT.fromCBOR(ur.cbor).getPSBT()
      if (psbt.length > 1024 * 1024) throw new Error('The PSBT is too large.')
      this.result = psbt.toString('hex')
      return { progress: 1, psbtHex: this.result }
    }
    return { progress: Math.min(0.99, this.decoder.estimatedPercentComplete()) }
  }
}
