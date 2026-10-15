import { AirGapWallet, AirGapWalletStatus } from '@airgap/coinlib-core'
import { IACMessageDefinitionObjectV3, generateId, IACMessageType, AccountShareResponse } from '@airgap/serializer'
import { Injectable } from '@angular/core'

import { MnemonicSecret } from '../../models/secret'
import { WalletAccessService } from '../wallet-access/wallet-access.service'

@Injectable({ providedIn: 'root' })
export class ShareUrlService {
  constructor(private readonly access: WalletAccessService) {}

  public async generateShareWalletURL(wallet: AirGapWallet): Promise<IACMessageDefinitionObjectV3[]> {
    const contextId = this.access.getContextId()
    this.access.assertWallet(wallet)
    const secret = this.access.getCurrentSecret()
    const payload: AccountShareResponse = {
      publicKey: wallet.publicKey,
      isExtendedPublicKey: wallet.isExtendedPublicKey,
      derivationPath: wallet.derivationPath,
      masterFingerprint: wallet.masterFingerprint,
      isActive: wallet.status === AirGapWalletStatus.ACTIVE,
      groupId: this.access.getShareGroupId(secret),
      groupLabel: secret.label ?? ''
    }
    const protocol = await wallet.protocol.getIdentifier()
    this.access.assertContext(contextId)
    this.access.assertWallet(wallet, secret)
    return [{ id: generateId(8), protocol, type: IACMessageType.AccountShareResponse, payload }]
  }

  /** The argument selects the current Secret only; it cannot export locked Secrets or other profiles. */
  public async generateShareSecretsURL(secrets: MnemonicSecret[]): Promise<IACMessageDefinitionObjectV3[]> {
    const contextId = this.access.getContextId()
    const current = this.access.getCurrentSecret()
    if (secrets.some((secret) => secret.id !== current.id)) {
      throw new Error('Open the selected Secret before sharing its accounts.')
    }
    const wallets = secrets.length === 0 ? [] : this.access.getWallets(current)
      .filter((wallet) => wallet.status !== AirGapWalletStatus.DELETED)
    const messages = (await Promise.all(wallets.map((wallet) => this.generateShareWalletURL(wallet)))).reduce((all, next) => all.concat(next), [])
    this.access.assertContext(contextId)
    return messages
  }
}
