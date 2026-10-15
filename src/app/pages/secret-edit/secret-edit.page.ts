import { Component } from '@angular/core'
import { PopoverController, Platform, ToastController, AlertController } from '@ionic/angular'

import { MnemonicSecret } from '../../models/secret'
import { ErrorCategory, handleErrorLocal } from '../../services/error-handler/error-handler.service'
import { NavigationService } from '../../services/navigation/navigation.service'
import { SecretsService } from '../../services/secrets/secrets.service'

import { TranslateService } from '@ngx-translate/core'
import { ClipboardService } from '@airgap/angular-core'
import { AdvancedModeType, VaultStorageKey, VaultStorageService } from 'src/app/services/storage/storage.service'
import { Observable, Subscription } from 'rxjs'
import { first, map } from 'rxjs/operators'
import { LifehashService } from 'src/app/services/lifehash/lifehash.service'
import { Router } from '@angular/router'
import { WalletAccessService } from '../../services/wallet-access/wallet-access.service'

export enum SecretEditAction {
  SET_RECOVERY_KEY
}

@Component({
  selector: 'airgap-secret-edit',
  templateUrl: './secret-edit.page.html',
  styleUrls: ['./secret-edit.page.scss']
})
export class SecretEditPage {
  public isGenerating: boolean = false

  public isAndroid: boolean = false

  public secret: MnemonicSecret

  private readonly onDelete: Function

  public lifehashData: string = ''
  public passphrases: { id: string; isDefault: boolean }[] = []
  public newPassphrase: string = ''
  public confirmPassphrase: string = ''
  public newDefaultPassword: string = ''
  public confirmDefaultPassword: string = ''
  public accessBusy: boolean = false
  public accessMessage: string = ''
  private active: boolean = false
  private revision: number = 0
  private actionPerformed: boolean = false
  private readonly accessSubscription: Subscription
  private readonly managedAlerts: Set<HTMLIonAlertElement> = new Set()

  public get canManage(): boolean {
    return this.active && !!this.secret && this.walletAccess.isDefaultUnlocked(this.secret)
  }

  public get canRegisterPassphrase(): boolean {
    return this.canManage && !this.accessBusy && this.newPassphrase.length > 0 && this.newPassphrase === this.confirmPassphrase
  }

  public get canChangeDefaultPassword(): boolean {
    return this.canManage && !this.accessBusy && this.newDefaultPassword.length > 0 && this.newDefaultPassword === this.confirmDefaultPassword
  }

  public isAppAdvancedMode$: Observable<boolean> = this.storageService
    .subscribe(VaultStorageKey.ADVANCED_MODE_TYPE)
    .pipe(map((res) => res === AdvancedModeType.ADVANCED))

  constructor(
    private readonly toastCtrl: ToastController,
    private readonly alertCtrl: AlertController,
    private readonly translateService: TranslateService,
    private readonly clipboardService: ClipboardService,
    private readonly secretsService: SecretsService,
    private readonly navigationService: NavigationService,
    private readonly storageService: VaultStorageService,
    private readonly lifehashService: LifehashService,
    private readonly platform: Platform,
    private readonly router: Router,
    private readonly popoverController: PopoverController,
    public readonly walletAccess: WalletAccessService
  ) {
    if (this.navigationService.getState()) {
      this.secret = this.navigationService.getState().secret

      if (!this.secret) {
        this.router.navigate(['/'])
        throw new Error('[SecretEditPage]: No secret found! Navigating to home page.')
      }

      this.isAndroid = this.platform.is('android')

    }
    this.accessSubscription = this.walletAccess.changes$.subscribe(() => {
      this.revision++
      if (this.active && !this.canManage) {
        this.active = false
        this.clearAccessInputs()
        this.closeManagedAlerts()
        this.passphrases = []
        this.navigationService.routeToSecretsTab().catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
      }
    })
  }

  public async ionViewWillEnter(): Promise<void> {
    this.active = true
    if (!this.canManage) {
      this.clearAccessInputs()
      this.passphrases = []
      await this.navigationService.routeToSecretsTab()
      return
    }
    try {
      await this.loadPassphrases()
    } catch (_error) {
      if (this.canManage) {
        this.accessMessage = 'wallet-access.manage-error'
      }
    }
    if (this.active && this.canManage && !this.actionPerformed) {
      this.actionPerformed = true
      this.perform(this.navigationService.getState().action)
    }
  }

  public ionViewDidLeave(): void {
    this.active = false
    this.revision++
    this.clearAccessInputs()
    this.closeManagedAlerts()
    this.passphrases = []
    this.accessMessage = ''
  }

  public ngOnDestroy(): void {
    this.ionViewDidLeave()
    this.accessSubscription.unsubscribe()
  }

  public clearAccessInputs(): void {
    this.newPassphrase = ''
    this.confirmPassphrase = ''
    this.newDefaultPassword = ''
    this.confirmDefaultPassword = ''
  }

  private closeManagedAlerts(): void {
    for (const alert of this.managedAlerts) {
      alert.message = ''
      alert.inputs = []
      alert.buttons = []
      alert.dismiss(undefined, 'cancel').catch(() => undefined)
    }
    this.managedAlerts.clear()
  }

  private async presentManagedAlert(alert: HTMLIonAlertElement): Promise<void> {
    if (!this.canManage) {
      alert.message = ''
      alert.inputs = []
      alert.buttons = []
      return
    }
    this.managedAlerts.add(alert)
    await alert.present()
    if (!this.canManage) {
      alert.message = ''
      alert.inputs = []
      alert.buttons = []
      await alert.dismiss(undefined, 'cancel')
      this.managedAlerts.delete(alert)
      return
    }
    alert.onDidDismiss().then(() => {
      this.managedAlerts.delete(alert)
      alert.message = ''
      alert.inputs = []
      alert.buttons = []
    }).catch(() => undefined)
  }

  private async loadPassphrases(): Promise<void> {
    if (!this.active || !this.canManage) {
      return
    }
    const revision = this.revision
    const passphrases = await this.walletAccess.listPassphrases(this.secret)
    if (this.active && this.canManage && revision === this.revision) {
      this.passphrases = passphrases.filter((entry) => !entry.isDefault)
    }
  }

  public async registerPassphrase(): Promise<void> {
    if (!this.canRegisterPassphrase) {
      return
    }
    this.accessBusy = true
    this.accessMessage = ''
    try {
      await this.walletAccess.registerPassphrase(this.secret, this.newPassphrase)
      if (this.active && this.canManage) {
        await this.loadPassphrases()
        this.accessMessage = 'wallet-access.passphrase-added'
      }
    } catch (_error) {
      if (this.active && this.canManage) {
        this.accessMessage = 'wallet-access.manage-error'
      }
    } finally {
      this.clearAccessInputs()
      this.accessBusy = false
    }
  }

  public async changeDefaultPassword(): Promise<void> {
    if (!this.canChangeDefaultPassword) {
      return
    }
    this.accessBusy = true
    this.accessMessage = ''
    try {
      await this.walletAccess.changeDefaultPassword(this.secret, this.newDefaultPassword)
      if (this.active && this.canManage) {
        this.accessMessage = 'wallet-access.default-changed'
      }
    } catch (_error) {
      if (this.active && this.canManage) {
        this.accessMessage = 'wallet-access.manage-error'
      }
    } finally {
      this.clearAccessInputs()
      this.accessBusy = false
    }
  }

  public async removePassphrase(id: string): Promise<void> {
    if (!this.canManage || this.accessBusy || !this.passphrases.some((entry) => entry.id === id)) {
      return
    }
    const alert = await this.alertCtrl.create({
      header: this.translateService.instant('wallet-access.remove-passphrase'),
      message: this.translateService.instant('wallet-access.remove-explanation'),
      buttons: [
        { text: this.translateService.instant('wallet-access.cancel'), role: 'cancel' },
        {
          text: this.translateService.instant('wallet-access.remove'),
          handler: async () => {
            if (!this.active || !this.canManage || this.accessBusy) {
              return
            }
            this.accessBusy = true
            this.accessMessage = ''
            try {
              await this.walletAccess.removePassphrase(this.secret, id)
              if (this.active && this.canManage) {
                await this.loadPassphrases()
                this.accessMessage = 'wallet-access.passphrase-removed'
              }
            } catch (_error) {
              if (this.active && this.canManage) {
                this.accessMessage = 'wallet-access.manage-error'
              }
            } finally {
              this.accessBusy = false
            }
          }
        }
      ]
    })
    await this.presentManagedAlert(alert)
  }

  public async ngOnInit() {
    const bytes = this.secret.fingerprint
      ? new Uint8Array(this.secret.fingerprint.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)))
      : new Uint8Array()

    this.lifehashData = await this.lifehashService.generateLifehash(bytes)
  }

  public goToSocialRecoverySetup(): void {
    if (!this.canManage) {
      return
    }
    this.navigationService
      .routeWithState('/social-recovery-generate-intro', { secret: this.secret })
      .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }

  public goToWalletInteraction(): void {
    if (!this.canManage) {
      return
    }
    this.navigationService
      .routeWithState('/interaction-selection-settings', { secret: this.secret, isEdit: true })
      .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }

  public goToBip85ChildSeed(): void {
    if (!this.canManage) {
      return
    }
    this.navigationService
      .routeWithState('/bip85-generate', { secret: this.secret })
      .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }

  public async resetRecoveryPassword(): Promise<void> {
    if (!this.canManage) {
      return
    }
    try {
      const recoveryKey = await this.secretsService.resetRecoveryPassword(this.secret)
      if (this.active && this.canManage) {
        await this.showRecoveryKeyAlert(recoveryKey)
      }
    } catch (e) {
      this.showToast('secret-edit.secret-recovery-key.reset-error')
    }
  }

  public async showMnemonic() {
    if (!this.canManage) {
      return
    }
    const alert = await this.alertCtrl.create({
      header: this.translateService.instant('secret-edit.show-mnemonic.alert.title'),
      message: this.translateService.instant('secret-edit.show-mnemonic.alert.message'),
      backdropDismiss: false,
      inputs: [
        {
          name: 'understood',
          type: 'checkbox',
          label: this.translateService.instant('secret-edit.show-mnemonic.alert.understood'),
          value: 'understood',
          checked: false
        }
      ],
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel'
        },
        {
          text: 'Ok',
          handler: async (result: string[]) => {
            if (this.active && this.canManage && result.includes('understood')) {
              const entropy = await this.secretsService.retrieveEntropyForSecret(this.secret)
              if (!this.active || !this.canManage) {
                return
              }
              const secret = new MnemonicSecret(entropy)
              this.navigationService.routeWithState('secret-show', { secret }).catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
            }
          }
        }
      ]
    })
    await this.presentManagedAlert(alert)
  }

  public delete(): void {
    if (!this.canManage) {
      return
    }
    this.translateService
      .get([
        'secret-edit-delete-popover.title',
        'secret-edit-delete-popover.text',
        'secret-edit-delete-popover.cancel_label',
        'secret-edit-delete-popover.delete_label'
      ])
      .pipe(first())
      .subscribe(async (values: string[]) => {
        if (!this.active || !this.canManage) {
          return
        }
        const title: string = values['secret-edit-delete-popover.title']
        const message: string = values['secret-edit-delete-popover.text']
        const cancelButton: string = values['secret-edit-delete-popover.cancel_label']
        const deleteButton: string = values['secret-edit-delete-popover.delete_label']

        const alert: HTMLIonAlertElement = await this.alertCtrl.create({
          header: title,
          message,
          buttons: [
            {
              text: cancelButton,
              role: 'cancel',
              handler: (): void => {
                this.popoverController.dismiss().catch(handleErrorLocal(ErrorCategory.IONIC_MODAL))
              }
            },
            {
              text: deleteButton,
              handler: async (): Promise<void> => {
                if (!this.active || !this.canManage) {
                  return
                }
                await this.secretsService.remove(this.secret)
                this.walletAccess.lock()
                this.popoverController.dismiss().catch(handleErrorLocal(ErrorCategory.IONIC_MODAL))

                if (this.onDelete) {
                  this.onDelete()
                }
                await this.navigationService.routeToSecretsTab()
              }
            }
          ]
        })
        this.presentManagedAlert(alert).catch(handleErrorLocal(ErrorCategory.IONIC_ALERT))
      })
  }

  private perform(action: SecretEditAction | undefined): void {
    switch (action) {
      case SecretEditAction.SET_RECOVERY_KEY:
        this.resetRecoveryPassword()
        break
    }
  }

  private async showToast(message: string) {
    const toast: HTMLIonToastElement = await this.toastCtrl.create({
      message: this.translateService.instant(message),
      duration: 1000,
      position: 'top',
      buttons: [
        {
          text: 'Ok',
          role: 'cancel'
        }
      ]
    })
    toast.present().catch(handleErrorLocal(ErrorCategory.IONIC_ALERT))
  }

  private async showRecoveryKeyAlert(recoveryKey: string): Promise<void> {
    const alert: HTMLIonAlertElement = await this.alertCtrl.create({
      header: this.translateService.instant('secret-edit.secret-recovery-key.alert.title'),
      subHeader: this.translateService.instant('secret-edit.secret-recovery-key.description'),
      message: recoveryKey,
      buttons: [
        {
          text: this.translateService.instant('secret-edit.secret-recovery-key.alert.copy'),
          handler: () => {
            if (!this.active || !this.canManage) {
              return
            }
            this.clipboardService.copy(recoveryKey)
            this.showToast('secret-edit.secret-recovery-key.copied')
          }
        },
        {
          text: this.translateService.instant('secret-edit.secret-recovery-key.alert.done'),
          handler: () => {}
        }
      ]
    })
    await this.presentManagedAlert(alert)
  }

  async onChangeName(event: any) {
    if (!this.canManage) {
      return
    }
    this.secret.label = event.target.value

    try {
      await this.secretsService.addOrUpdateSecret(this.secret)
    } catch (error) {
      handleErrorLocal(ErrorCategory.SECURE_STORAGE)(error)

      return
    }
  }

  public navigateToRecoverySettings() {
    if (!this.canManage) {
      return
    }
    try {
      this.perform(SecretEditAction.SET_RECOVERY_KEY)
    } catch (error) {
      this.showToast(error)
    }
  }
}
