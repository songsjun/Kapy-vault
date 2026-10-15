import { Component, OnDestroy, OnInit } from '@angular/core'
import { AlertController, PopoverController } from '@ionic/angular'
import { TranslateService } from '@ngx-translate/core'
import { AirGapWallet, ProtocolSymbols } from '@airgap/coinlib-core'
import { first } from 'rxjs/operators'
import { ClipboardService } from '@airgap/angular-core'
import { SecretsService } from '../../../services/secrets/secrets.service'
import { NavigationService } from '../../../services/navigation/navigation.service'
import { WalletAccessService } from '../../../services/wallet-access/wallet-access.service'

@Component({
  selector: 'airgap-account-edit-popover',
  templateUrl: 'account-edit-popover.component.html',
  styleUrls: ['./account-edit-popover.component.scss']
})
export class AccountEditPopoverComponent implements OnInit, OnDestroy {
  public wallet: AirGapWallet
  public contextId: number
  public protocolIdentifier: ProtocolSymbols
  private onDelete?: () => void
  private openAddressQR?: () => void | Promise<void>
  private getWalletShareUrl?: () => Promise<string>
  private closed = false
  private alert?: HTMLIonAlertElement
  private readonly unregisterCleanup: () => void

  public get canView(): boolean {
    try { this.assertCurrent(); return true } catch { return false }
  }

  constructor(
    private readonly alertCtrl: AlertController,
    private readonly clipboardService: ClipboardService,
    private readonly secretsService: SecretsService,
    private readonly popoverController: PopoverController,
    private readonly translateService: TranslateService,
    private readonly navigationService: NavigationService,
    private readonly access: WalletAccessService
  ) {
    this.unregisterCleanup = this.navigationService.registerSensitiveCleanup(() => this.clearView())
  }

  public async ngOnInit(): Promise<void> {
    this.assertCurrent()
    const identifier = await this.wallet.protocol.getIdentifier()
    this.assertCurrent()
    this.protocolIdentifier = identifier
  }

  public ngOnDestroy(): void { this.clearView(false); this.unregisterCleanup() }

  private assertCurrent(): void {
    if (this.closed || !this.wallet) throw new Error('This account menu is closed.')
    this.access.assertContext(this.contextId)
    this.access.assertWallet(this.wallet)
  }

  private clearView(dismiss = true): void {
    this.closed = true
    this.wallet = undefined
    this.protocolIdentifier = undefined
    this.getWalletShareUrl = undefined
    this.openAddressQR = undefined
    this.onDelete = undefined
    this.alert?.dismiss().catch(() => undefined)
    this.alert = undefined
    if (dismiss) this.popoverController.dismiss().catch(() => undefined)
  }

  public async copyAddressToClipboard(): Promise<void> {
    this.assertCurrent()
    await this.clipboardService.copyAndShowToast(
      this.wallet.receivingPublicAddress, this.translateService.instant('wallet-edit-delete-popover.confirm_address_copy')
    )
    await this.popoverController.dismiss()
  }

  public async copyShareUrlToClipboard(): Promise<void> {
    this.assertCurrent()
    const shareUrl = await this.getWalletShareUrl()
    this.assertCurrent()
    await this.clipboardService.copyAndShowToast(shareUrl, this.translateService.instant('wallet-edit-delete-popover.confirm_sync_code_copy'))
    await this.popoverController.dismiss()
  }

  public async showAddressQR(): Promise<void> {
    this.assertCurrent()
    await this.openAddressQR()
    this.assertCurrent()
    await this.popoverController.dismiss()
  }

  public async openAddressExplorer(): Promise<void> {
    this.assertCurrent()
    await this.navigationService.routeWithState('/address-explorer', { wallet: this.wallet, contextId: this.contextId })
    await this.popoverController.dismiss()
  }

  public async delete(): Promise<void> {
    this.assertCurrent()
    const wallet = this.wallet
    const contextId = this.contextId
    const values = await this.translateService.get([
      'wallet-edit-delete-popover.account-removal_alert.title',
      'wallet-edit-delete-popover.account-removal_alert.text',
      'wallet-edit-delete-popover.account-removal_alert.cancel_label',
      'wallet-edit-delete-popover.account-removal_alert.delete_label'
    ]).pipe(first()).toPromise()
    this.assertCurrent()
    const alert = await this.alertCtrl.create({
      header: values['wallet-edit-delete-popover.account-removal_alert.title'],
      message: values['wallet-edit-delete-popover.account-removal_alert.text'],
      buttons: [
        { text: values['wallet-edit-delete-popover.account-removal_alert.cancel_label'], role: 'cancel' },
        {
          text: values['wallet-edit-delete-popover.account-removal_alert.delete_label'],
          handler: async (): Promise<void> => {
            this.assertCurrent()
            await this.secretsService.removeWallet(wallet)
            this.access.assertContext(contextId)
            if (this.closed) return
            this.onDelete?.()
            await this.popoverController.dismiss()
          }
        }
      ]
    })
    try { this.assertCurrent() } catch (error) { alert.dismiss().catch(() => undefined); throw error }
    this.alert = alert
    await alert.present()
    try { this.assertCurrent() } catch (error) { alert.dismiss().catch(() => undefined); throw error }
  }
}
