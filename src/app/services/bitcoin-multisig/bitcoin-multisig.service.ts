import { Injectable } from '@angular/core'
import { entropyToMnemonic } from 'bip39'
import * as bitcoin from '@airgap/coinlib-core/dependencies/src/bitcoinjs-lib-6.1.7/src/index'

import { WalletAccessService } from '../wallet-access/wallet-access.service'
import { deriveMultisigCosigner, signMultisigPsbt, BitcoinMultisigNetwork, BitcoinMultisigScript } from './bitcoin-multisig'

@Injectable({ providedIn: 'root' })
export class BitcoinMultisigService {
  constructor(private readonly access: WalletAccessService) {}

  public async exportCosigner(contextId: number, network: BitcoinMultisigNetwork, scriptType: BitcoinMultisigScript, account: number) {
    this.access.assertContext(contextId)
    const secret = this.access.getCurrentSecret()
    const entropy = await this.access.readEntropy(secret)
    this.access.assertContext(contextId)
    const result = await deriveMultisigCosigner(entropyToMnemonic(entropy), this.access.getPassphrase(secret), { network, scriptType, account })
    this.access.assertContext(contextId)
    return result
  }

  public async sign(contextId: number, psbtHex: string, network: BitcoinMultisigNetwork) {
    this.access.assertContext(contextId)
    const secret = this.access.getCurrentSecret()
    const entropy = await this.access.readEntropy(secret)
    this.access.assertContext(contextId)
    const result = await signMultisigPsbt(psbtHex, entropyToMnemonic(entropy), this.access.getPassphrase(secret), network)
    this.access.assertContext(contextId)
    return result
  }
}

/** Used only to route existing QR scans; full validation happens in the dedicated flow. */
export function isMultisigPsbt(psbtHex: unknown): boolean {
  if (typeof psbtHex !== 'string' || psbtHex.length > 2 * 1024 * 1024) return false
  try {
    return bitcoin.Psbt.fromHex(psbtHex).data.inputs.some((input) => {
      const script = input.witnessScript ?? input.redeemScript
      return script && bitcoin.script.decompile(script)?.includes(bitcoin.opcodes.OP_CHECKMULTISIG)
    })
  } catch { return false }
}
