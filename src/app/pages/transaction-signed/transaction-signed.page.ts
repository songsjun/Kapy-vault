import { WalletAccessService } from '../../services/wallet-access/wallet-access.service'
import { Component } from '@angular/core'
import { AirGapWallet } from '@airgap/coinlib-core'
import { MessageSignResponse } from '@airgap/serializer'
import { TranslateService } from '@ngx-translate/core'

import { ErrorCategory, handleErrorLocal } from '../../services/error-handler/error-handler.service'
import { NavigationService } from '../../services/navigation/navigation.service'

enum TransactionQRType {
  SignedAirGap = 0,
  SignedRaw = 1
}

@Component({
  selector: 'airgap-transaction-signed',
  templateUrl: './transaction-signed.page.html',
  styleUrls: ['./transaction-signed.page.scss']
})
export class TransactionSignedPage {
  private contextId: number
  public get isCurrent(): boolean {
    try { this.access.assertContext(this.contextId); return true } catch { return false }
  }
  public signedTxs: string[]
  public interactionUrl: string

  public splits: string[]

  public pageTitle: string
  public heading: string
  public translationKey: string

  public messageSignResponse: MessageSignResponse
  public wallets: AirGapWallet[]
  public qrType: TransactionQRType = 0

  public signedTransactionSync: any // TODO: Types

  public addressesNotOnContactBook: string[] = []

  constructor(public navigationService: NavigationService, private readonly translateService: TranslateService, private readonly access: WalletAccessService) {
    this.contextId = this.navigationService.getState().contextId
    this.interactionUrl = this.navigationService.getState().interactionUrl
    this.wallets = this.navigationService.getState().wallets
    this.signedTxs = this.navigationService.getState().signedTxs
    this.translationKey = this.navigationService.getState().translationKey
    this.pageTitle = this.translateService.instant(`${this.translationKey}.title`)
    this.heading = this.translateService.instant(`${this.translationKey}.heading`)
    this.messageSignResponse = this.navigationService.getState().messageSignResponse
  }

  ionViewWillEnter() {
    const state = this.navigationService.getState()
    this.contextId = state.contextId
    this.interactionUrl = state.interactionUrl
    this.wallets = state.wallets
    this.signedTxs = state.signedTxs
    this.messageSignResponse = state.messageSignResponse
    this.translationKey = state.translationKey
    this.pageTitle = this.translateService.instant(`${this.translationKey}.title`)
    this.heading = this.translateService.instant(`${this.translationKey}.heading`)
    if (!this.isCurrent) { this.interactionUrl = null; this.signedTxs = []; this.messageSignResponse = undefined; return }
    const temp = this.interactionUrl
    this.interactionUrl = null
    this.interactionUrl = temp
  }

  public done(): void {
    this.navigationService.routeToSecretsTab().catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }
}
