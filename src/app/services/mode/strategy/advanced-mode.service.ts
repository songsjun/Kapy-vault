import { Injectable } from '@angular/core'

import { ErrorCategory, handleErrorLocal } from '../../error-handler/error-handler.service'
import { NavigationService } from '../../navigation/navigation.service'
import { WalletAccessService } from '../../wallet-access/wallet-access.service'

import { ModeStrategy } from './ModeStrategy'

@Injectable({
  providedIn: 'root'
})
export class AdvancedModeSerivce implements ModeStrategy {
  constructor(private readonly navigationService: NavigationService, private readonly access: WalletAccessService) {}

  public async syncAll(): Promise<void> {
    const contextId = this.access.getContextId()
    const secret = this.access.getCurrentSecret()
    await this.navigationService.routeWithState('/account-share-select', { secret, contextId })
      .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }
}
