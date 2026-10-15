import { Injectable } from '@angular/core'
import { InteractionOperationType, InteractionService } from '../../interaction/interaction.service'
import { ShareUrlService } from '../../share-url/share-url.service'
import { WalletAccessService } from '../../wallet-access/wallet-access.service'
import { ModeStrategy } from './ModeStrategy'

@Injectable({ providedIn: 'root' })
export class BasicModeService implements ModeStrategy {
  constructor(
    private readonly shareUrlService: ShareUrlService,
    private readonly interactionService: InteractionService,
    private readonly access: WalletAccessService
  ) {}

  public async syncAll(): Promise<void> {
    const contextId = this.access.getContextId()
    const messages = await this.shareUrlService.generateShareSecretsURL([this.access.getCurrentSecret()])
    this.access.assertContext(contextId)
    await this.interactionService.startInteraction({ contextId, operationType: InteractionOperationType.WALLET_SYNC, iacMessage: messages })
  }
}
