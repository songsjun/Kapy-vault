import { Component, Input, OnDestroy, OnInit } from '@angular/core'
import { AlertController } from '@ionic/angular'
import { TranslateService } from '@ngx-translate/core'
import { Observable } from 'rxjs'
import { map } from 'rxjs/operators'
import { ErrorCategory, handleErrorLocal } from 'src/app/services/error-handler/error-handler.service'
import { NavigationService } from 'src/app/services/navigation/navigation.service'
import { LifehashService } from 'src/app/services/lifehash/lifehash.service'
import { WalletAccessService } from 'src/app/services/wallet-access/wallet-access.service'
import { MnemonicSecret } from '../../models/secret'
import { AdvancedModeType, VaultStorageKey, VaultStorageService } from 'src/app/services/storage/storage.service'

@Component({
  selector: 'airgap-secret-item',
  templateUrl: './secret-item.component.html',
  styleUrls: ['./secret-item.component.scss']
})
export class SecretItemComponent implements OnInit, OnDestroy {
  @Input()
  public secret: MnemonicSecret
  public lifehashData: string = ''
  public opening: boolean = false
  private destroyed: boolean = false
  private alert?: HTMLIonAlertElement
  private unlocking: boolean = false
  private attempt: number = 0

  public isAdvancedMode$: Observable<boolean> = this.storageService
    .subscribe(VaultStorageKey.ADVANCED_MODE_TYPE)
    .pipe(map((res) => res === AdvancedModeType.ADVANCED))

  constructor(
    public navigationService: NavigationService,
    private readonly lifehashService: LifehashService,
    private readonly storageService: VaultStorageService,
    public readonly walletAccess: WalletAccessService,
    private readonly alertCtrl: AlertController,
    private readonly translateService: TranslateService
  ) {}

  public async ngOnInit(): Promise<void> {
    const matches = this.secret.fingerprint?.match(/.{1,2}/g)
    const bytes = new Uint8Array((matches ?? []).map((byte) => parseInt(byte, 16)))
    const data = await this.lifehashService.generateLifehash(bytes)
    if (!this.destroyed) {
      this.lifehashData = data
    }
  }

  public ngOnDestroy(): void {
    this.destroyed = true
    this.attempt++
    if (this.unlocking) {
      this.walletAccess.lock()
    }
    if (this.alert) {
      this.alert.inputs = []
      this.alert.dismiss(undefined, 'cancel').catch(() => undefined)
    }
  }

  public async goToAccountsList(): Promise<void> {
    if (this.opening || this.destroyed) {
      return
    }
    this.opening = true
    this.walletAccess.lock()
    try {
      if (!this.walletAccess.isConfigured(this.secret)) {
        const notice = await this.alertCtrl.create({
          header: this.translateService.instant('wallet-access.legacy-title'),
          message: this.translateService.instant('wallet-access.legacy-message'),
          buttons: [this.translateService.instant('wallet-access.ok')]
        })
        this.alert = notice
        if (this.destroyed) {
          return
        }
        await notice.present()
        if (this.destroyed) {
          await notice.dismiss(undefined, 'cancel')
        }
        await notice.onDidDismiss()
        this.alert = undefined
        return
      }

      let unlocked = false
      const attempt = ++this.attempt
      const passwordInput = () => [{
        name: 'password',
        type: 'password' as const,
        placeholder: this.translateService.instant('wallet-access.password'),
        attributes: { autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }
      }]
      const alert = await this.alertCtrl.create({
        header: this.translateService.instant('wallet-access.unlock-title'),
        // Secret labels are user input; do not put them in Ionic's HTML message.
        message: this.translateService.instant('wallet-access.unlock-message'),
        backdropDismiss: false,
        inputs: passwordInput(),
        buttons: [
          {
            text: this.translateService.instant('wallet-access.cancel'),
            role: 'cancel',
            handler: () => {
              this.attempt++
              this.walletAccess.lock()
            }
          },
          {
            text: this.translateService.instant('wallet-access.unlock'),
            handler: async (data: { password?: string }) => {
              if (this.unlocking || this.destroyed || attempt !== this.attempt || !data.password?.length) {
                return false
              }
              const password = data.password
              data.password = ''
              this.unlocking = true
              try {
                await this.walletAccess.unlock(this.secret, password)
                if (this.destroyed || attempt !== this.attempt) {
                  return false
                }
                unlocked = this.walletAccess.isUnlocked(this.secret)
                return unlocked
              } catch (_error) {
                if (!this.destroyed && attempt === this.attempt) {
                  alert.message = this.translateService.instant('wallet-access.unlock-error')
                  alert.inputs = passwordInput()
                }
                return false
              } finally {
                this.unlocking = false
              }
            }
          }
        ]
      })
      this.alert = alert
      if (this.destroyed) {
        alert.inputs = []
        return
      }
      await alert.present()
      if (this.destroyed) {
        alert.inputs = []
        await alert.dismiss(undefined, 'cancel')
      }
      const result = await alert.onDidDismiss()
      this.attempt++
      alert.inputs = []
      this.alert = undefined
      if (unlocked && result.role !== 'cancel' && !this.destroyed && this.walletAccess.isUnlocked(this.secret)) {
        await this.navigationService.routeWithState('/accounts-list', { secret: this.walletAccess.getCurrentSecret() })
      } else if (this.unlocking) {
        this.walletAccess.lock()
      }
    } catch (error) {
      handleErrorLocal(ErrorCategory.IONIC_ALERT)(error)
    } finally {
      if (this.alert) {
        this.alert.inputs = []
      }
      this.opening = false
    }
  }
}
