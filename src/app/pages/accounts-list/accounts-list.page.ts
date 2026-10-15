import { AirGapWallet, AirGapWalletStatus } from '@airgap/coinlib-core'
import { Component } from '@angular/core'
import { AlertController, Platform, PopoverController } from '@ionic/angular'
import { TranslateService } from '@ngx-translate/core'
import { BehaviorSubject, Subscription } from 'rxjs'
import { MnemonicSecret } from 'src/app/models/secret'
import { ErrorCategory, handleErrorLocal } from 'src/app/services/error-handler/error-handler.service'
import { ModeService } from 'src/app/services/mode/mode.service'
import { ModeStrategy } from 'src/app/services/mode/strategy/ModeStrategy'
import { NavigationService } from 'src/app/services/navigation/navigation.service'
import { SecretsService } from 'src/app/services/secrets/secrets.service'
import { WalletAccessService } from 'src/app/services/wallet-access/wallet-access.service'
import { AccountsListEditPopoverComponent } from './accounts-list-edit-popover/accounts-list-edit-popover.component'

@Component({
  selector: 'airgap-accounts-list',
  templateUrl: './accounts-list.page.html',
  styleUrls: ['./accounts-list.page.scss']
})
export class AccountsListPage {
  public secret: MnemonicSecret
  public deleteView: boolean = false
  public wallets$: BehaviorSubject<AirGapWallet[]> = new BehaviorSubject<AirGapWallet[]>([])
  public selectedWallets: AirGapWallet[] = []
  public readonly isAndroid: boolean
  public readonly AirGapWalletStatus: typeof AirGapWalletStatus = AirGapWalletStatus
  private active: boolean = false
  private revision: number = 0
  private readonly accessSubscription: Subscription

  public get canView(): boolean {
    return this.active && !!this.secret && this.walletAccess.isUnlocked(this.secret)
  }

  constructor(
    private readonly platform: Platform,
    private readonly navigationService: NavigationService,
    private readonly modeService: ModeService,
    private readonly alertCtrl: AlertController,
    private readonly translateService: TranslateService,
    private readonly secretsService: SecretsService,
    private readonly popoverCtrl: PopoverController,
    public readonly walletAccess: WalletAccessService
  ) {
    this.isAndroid = this.platform.is('android')
    this.accessSubscription = this.walletAccess.changes$.subscribe(() => {
      this.clearView()
      if (this.active) {
        if (this.canView) {
          this.secret = this.walletAccess.getCurrentSecret()
          this.loadWallets().catch(handleErrorLocal(ErrorCategory.SECURE_STORAGE))
        } else {
          this.navigationService.routeToSecretsTab().catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
        }
      }
    })
  }

  public ionViewWillEnter(): void {
    this.active = true
    this.clearView()
    const requestedSecret: MnemonicSecret | undefined = this.navigationService.getState()?.secret
    const currentSecret = this.walletAccess.getCurrentSecret()
    if (!requestedSecret || !currentSecret || requestedSecret.id !== currentSecret.id || !this.walletAccess.isUnlocked(currentSecret)) {
      this.secret = undefined
      this.navigationService.routeToSecretsTab().catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
      return
    }
    this.secret = currentSecret
    this.loadWallets().catch(handleErrorLocal(ErrorCategory.SECURE_STORAGE))
  }

  public ionViewDidLeave(): void {
    this.active = false
    this.clearView()
  }

  public ngOnDestroy(): void {
    this.ionViewDidLeave()
    this.accessSubscription.unsubscribe()
  }

  private clearView(): void {
    this.revision++
    this.wallets$.next([])
    this.selectedWallets = []
    this.deleteView = false
  }

  private containsWallet(wallet: AirGapWallet): boolean {
    return this.active && this.canView && this.walletAccess.getWallets(this.secret).includes(wallet)
  }

  private async loadWallets(): Promise<void> {
    if (!this.active || !this.canView) {
      return
    }
    const revision = ++this.revision
    const wallets = this.walletAccess.getWallets(this.secret)
    const comparableWallets: [string, AirGapWallet][] = await Promise.all(
      wallets.map(async (wallet): Promise<[string, AirGapWallet]> => [await wallet.protocol.getName(), wallet])
    )
    if (!this.active || !this.canView || revision !== this.revision) {
      return
    }
    const currentWallets = this.walletAccess.getWallets(this.secret)
    this.wallets$.next(comparableWallets
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, wallet]) => wallet)
      .filter((wallet) => currentWallets.includes(wallet)))
  }

  public goToReceiveAddress(wallet: AirGapWallet): void {
    if (!this.containsWallet(wallet)) {
      return
    }
    this.navigationService.routeWithState('/account-address', { wallet, secret: this.secret })
      .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }

  public async syncWallets(): Promise<void> {
    if (!this.active || !this.canView) {
      return
    }
    const strategy: ModeStrategy = await this.modeService.strategy()
    if (this.active && this.canView) {
      await strategy.syncAll()
    }
  }

  public addWallet(): void {
    if (this.active && this.canView) {
      this.navigationService.routeWithState('/account-add', { secret: this.secret }).catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
    }
  }

  public goToEditSecret(): void {
    if (this.active && this.canView && this.walletAccess.isDefaultUnlocked(this.secret)) {
      this.navigationService.routeWithState('/secret-edit', { secret: this.secret }).catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
    }
  }

  public async presentEditPopover(event: Event): Promise<void> {
    if (!this.active || !this.canView) {
      return
    }
    const popover: HTMLIonPopoverElement = await this.popoverCtrl.create({
      component: AccountsListEditPopoverComponent,
      componentProps: {
        canManageSecret: this.walletAccess.isDefaultUnlocked(this.secret),
        onClickSyncWallets: (): void => {
          this.syncWallets().catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
          popover.dismiss().catch(handleErrorLocal(ErrorCategory.IONIC_MODAL))
        },
        onClickToggleDeleteView: (): void => {
          this.toggleDeleteView()
          popover.dismiss().catch(handleErrorLocal(ErrorCategory.IONIC_MODAL))
        },
        onClickAddWallet: (): void => {
          this.addWallet()
          popover.dismiss().catch(handleErrorLocal(ErrorCategory.IONIC_MODAL))
        },
        onClickEditSecret: (): void => {
          this.goToEditSecret()
          popover.dismiss().catch(handleErrorLocal(ErrorCategory.IONIC_MODAL))
        }
      },
      event,
      translucent: true
    })
    if (this.active && this.canView) {
      await popover.present()
    }
  }

  public async delete(wallet: AirGapWallet): Promise<void> {
    if (!this.containsWallet(wallet)) {
      return
    }
    const prefix = 'wallet-edit-delete-popover.account-removal_alert.'
    const alert = await this.alertCtrl.create({
      header: this.translateService.instant(prefix + 'title'),
      message: this.translateService.instant(prefix + 'text'),
      buttons: [
        { text: this.translateService.instant(prefix + 'cancel_label'), role: 'cancel' },
        {
          text: this.translateService.instant(prefix + 'delete_label'),
          handler: async () => {
            if (!this.containsWallet(wallet)) {
              return
            }
            try {
              await this.secretsService.removeWallet(wallet)
              await this.loadWallets()
            } catch (error) {
              handleErrorLocal(ErrorCategory.SECURE_STORAGE)(error)
            }
          }
        }
      ]
    })
    if (this.containsWallet(wallet)) {
      await alert.present()
    }
  }

  public onWalletSelected(event: CustomEvent & { detail: { checked: boolean } }, wallet: AirGapWallet): void {
    if (!this.containsWallet(wallet)) {
      return
    }
    const index = this.selectedWallets.indexOf(wallet)
    if (event.detail.checked && index === -1) {
      this.selectedWallets.push(wallet)
    } else if (!event.detail.checked && index !== -1) {
      this.selectedWallets.splice(index, 1)
    }
  }

  public async removeWallets(): Promise<void> {
    if (!this.active || !this.canView || this.selectedWallets.some((wallet) => !this.containsWallet(wallet))) {
      return
    }
    await this.secretsService.removeWallets([...this.selectedWallets])
    this.selectedWallets = []
    await this.loadWallets()
    this.deleteView = false
  }

  public toggleDeleteView(): void {
    if (this.active && this.canView) {
      this.deleteView = !this.deleteView
      this.selectedWallets = []
    }
  }

  public navigateToSecretsTab(): void {
    this.walletAccess.lock()
    this.clearView()
    this.navigationService.routeToSecretsTab().catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }
}
