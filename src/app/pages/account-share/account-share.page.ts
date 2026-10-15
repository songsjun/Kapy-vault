import { WalletAccessService } from '../../services/wallet-access/wallet-access.service'
import { ClipboardService } from '@airgap/angular-core'
import { IACMessageDefinitionObjectV3 } from '@airgap/serializer'
import { Component } from '@angular/core'
import { NavigationService } from '../../services/navigation/navigation.service'
import { airgapwallet, CompanionApp } from '../account-address/account-address.page'
import { ErrorCategory, handleErrorLocal } from './../../services/error-handler/error-handler.service'

@Component({
  selector: 'airgap-account-share',
  templateUrl: './account-share.page.html',
  styleUrls: ['./account-share.page.scss']
})
export class AccountSharePage {
  private contextId: number
  public get isCurrent(): boolean {
    try { this.access.assertContext(this.contextId); return true } catch { return false }
  }
  public interactionUrl: IACMessageDefinitionObjectV3[] = []
  public companionApp: CompanionApp
  public walletName: string
  public splits: string[] = []

  displayRawData: boolean = false

  constructor(private readonly navigationService: NavigationService, private readonly clipboardService: ClipboardService, private readonly access: WalletAccessService) {
    this.contextId = this.navigationService.getState().contextId
    this.interactionUrl = this.navigationService.getState().interactionUrl
    this.companionApp = this.navigationService.getState().companionApp ?? airgapwallet
    this.walletName = this.companionApp.name
  }

  public ionViewWillEnter(): void {
    const state = this.navigationService.getState()
    this.contextId = state.contextId
    this.interactionUrl = this.isCurrent ? state.interactionUrl : []
    this.companionApp = state.companionApp ?? airgapwallet
    this.walletName = this.companionApp.name
  }

  public done(): void {
    this.navigationService.routeToSecretsTab().catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }

  public copyToClipboard(): void {
    this.access.assertContext(this.contextId)
    this.clipboardService.copyAndShowToast(JSON.stringify(this.interactionUrl))
  }
}
