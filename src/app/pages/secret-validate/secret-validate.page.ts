import { Component, ViewChild } from '@angular/core'

import { VerifyKeyComponent } from '../../components/verify-key/verify-key.component'
import { MnemonicSecret } from '../../models/secret'
import { DeviceService } from '../../services/device/device.service'
import { ErrorCategory, handleErrorLocal } from '../../services/error-handler/error-handler.service'
import { NavigationService } from '../../services/navigation/navigation.service'

@Component({
  selector: 'airgap-secret-validate',
  templateUrl: './secret-validate.page.html',
  styleUrls: ['./secret-validate.page.scss']
})
export class SecretValidatePage {
  @ViewChild('verify', { static: false })
  public verify: VerifyKeyComponent

  public readonly secret: MnemonicSecret
  private sourceSecret?: MnemonicSecret
  private readonly unregisterCleanup: () => void

  constructor(private readonly deviceService: DeviceService, private readonly navigationService: NavigationService) {
    this.sourceSecret = this.navigationService.getState().secret
    this.navigationService.assertSecretDisplay(this.sourceSecret)
    this.secret = new MnemonicSecret(this.sourceSecret.secretHex, this.sourceSecret.label)
    this.unregisterCleanup = this.navigationService.registerSensitiveCleanup(() => {
      this.secret.secretHex = ''
      this.sourceSecret = undefined
      if (this.verify) {
        this.verify.secret = ''
        this.verify.splittedSecret = []
        this.verify.currentWords = []
        this.verify.promptedWords = []
      }
    })
  }

  public ionViewDidEnter(): void {
    this.navigationService.assertSecretDisplay(this.sourceSecret)
    this.deviceService.enableScreenshotProtection({ routeBack: 'secret-validate' })
  }

  public ionViewWillLeave(): void {
    this.deviceService.disableScreenshotProtection()
  }

  public onContinue(): void {
    this.goToSecretAddPage()
  }

  public goToSecretAddPage(): void {
    this.navigationService.assertSecretDisplay(this.sourceSecret)
    this.navigationService.routeWithState('secret-add', { secret: this.sourceSecret }).catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }

  public ngOnDestroy(): void {
    this.unregisterCleanup()
    this.secret.secretHex = ''
    this.sourceSecret = undefined
  }
}
