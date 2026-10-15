import { Component } from '@angular/core'
import { Platform } from '@ionic/angular'
import { Observable } from 'rxjs'
import { map } from 'rxjs/operators'
import { LifehashService } from 'src/app/services/lifehash/lifehash.service'
import { AdvancedModeType, VaultStorageKey, VaultStorageService } from 'src/app/services/storage/storage.service'
import { MnemonicSecret } from '../../models/secret'
import { ErrorCategory, handleErrorLocal } from '../../services/error-handler/error-handler.service'
import { NavigationService } from '../../services/navigation/navigation.service'
import { SecretsService } from '../../services/secrets/secrets.service'
import { UiEventService } from '@airgap/angular-core'
import { WalletAccessService } from '../../services/wallet-access/wallet-access.service'

@Component({
  selector: 'airgap-secret-add',
  templateUrl: './secret-add.page.html',
  styleUrls: ['./secret-add.page.scss']
})
export class SecretAddPage {
  public isGenerating: boolean = false

  public isAndroid: boolean = false

  public secret: MnemonicSecret

  public lifehashData: string | undefined
  public defaultPassword: string = ''
  public confirmPassword: string = ''
  public saving: boolean = false
  private left: boolean = false

  public get canSave(): boolean {
    return !!this.secret?.label?.length && this.defaultPassword.length > 0 && this.defaultPassword === this.confirmPassword && !this.saving
  }

  public isAdvancedMode$: Observable<boolean> = this.storageService
    .subscribe(VaultStorageKey.ADVANCED_MODE_TYPE)
    .pipe(map((res) => res === AdvancedModeType.ADVANCED))

  constructor(
    private readonly secretsService: SecretsService,
    private readonly navigationService: NavigationService,
    private readonly platform: Platform,
    private readonly lifehashService: LifehashService,
    private readonly storageService: VaultStorageService,
    private readonly uiEventService: UiEventService,
    private readonly walletAccess: WalletAccessService
  ) {
    if (this.navigationService.getState()) {
      this.isGenerating = this.navigationService.getState().isGenerating
      this.secret = this.navigationService.getState().secret
      this.isAndroid = this.platform.is('android')

      const matches = this.secret.fingerprint ? this.secret.fingerprint.match(/.{1,2}/g) : null
      const bytes = matches
        ? new Uint8Array(matches.map((byte) => parseInt(byte, 16)))
        : new Uint8Array()
      this.lifehashService.generateLifehash(bytes).then((data) => {
        this.lifehashData = data
      })
    }
  }

  public async confirm(): Promise<void> {
    if (!this.canSave || this.left) {
      return
    }
    this.saving = true
    try {
      await this.secretsService.createSecret(this.secret, this.defaultPassword)
    } catch (error) {
      if (this.left) {
        return
      }
      handleErrorLocal(ErrorCategory.SECURE_STORAGE)(error)

      if (error.message !== 'Already added secret') {
        await this.showErrorAlert()
      } else {
        const alert = await this.uiEventService.getTranslatedAlert({
          header: 'wallet-access.duplicate-title',
          message: 'wallet-access.duplicate-message',
          buttons: [{ text: 'wallet-access.ok', handler: () => this.navigationService.routeToSecretsTab() }]
        })
        if (!this.left) {
          await alert.present()
        }
      }
      return
    } finally {
      this.defaultPassword = ''
      this.confirmPassword = ''
      this.saving = false
    }

    if (this.left) {
      return
    }
    this.navigationService.routeWithStateAsRoot('/account-add', { secret: this.secret }).catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }

  public ionViewWillEnter(): void {
    this.left = false
  }

  public ionViewDidLeave(): void {
    this.left = true
    if (this.saving) {
      this.walletAccess.lock()
    }
    this.defaultPassword = ''
    this.confirmPassword = ''
  }

  public ngOnDestroy(): void {
    this.ionViewDidLeave()
  }

  public async togglePasscode(): Promise<void> {
    if (this.saving) {
      return
    }
    this.secret.isParanoia = !this.secret.isParanoia
  }

  private async showErrorAlert() {
    const alert = await this.uiEventService.getTranslatedAlert({
      header: 'secret-edit.error_alert.title',
      message: 'secret-edit.error_alert.message',
      backdropDismiss: true,
      buttons: [
        {
          text: 'secret-edit.error_alert.abort-button_label',
          handler: () => {
            this.navigationService.routeToSecretsTab()
          }
        },
        {
          text: 'secret-edit.error_alert.retry-button_label',
          role: 'cancel'
        }
      ]
    })

    await alert.present().catch(handleErrorLocal(ErrorCategory.IONIC_ALERT))
  }
}
