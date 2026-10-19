import { Component } from '@angular/core'
import { ActivatedRoute } from '@angular/router'
import { MnemonicSecret } from 'src/app/models/secret'
import { DeviceService } from 'src/app/services/device/device.service'
import { ErrorCategory, handleErrorLocal } from 'src/app/services/error-handler/error-handler.service'
import { NavigationService } from 'src/app/services/navigation/navigation.service'
import { DefaultSecretAccess } from '../../services/navigation/default-secret-access'

@Component({
  selector: 'airgap-social-recovery-generate-share-show',
  templateUrl: './social-recovery-generate-share-show.page.html',
  styleUrls: ['./social-recovery-generate-share-show.page.scss']
})
export class SocialRecoveryGenerateShareShowPage {
  public currentShare: number = 0
  public shares: string[]
  private secret: MnemonicSecret
  private required: number
  private access: DefaultSecretAccess

  get currentShares(): string[] {
    if (this.shares && this.currentShare < this.shares.length) {
      const currentShares = this.shares[this.currentShare].split(' ')
      return currentShares
    } else return ['No shares generated, something went wrong']
  }

  constructor(
    private readonly deviceService: DeviceService,
    private readonly navigationService: NavigationService,
    route: ActivatedRoute
  ) {
    route.params.subscribe((_) => {
      this.access?.dispose()
      this.currentShare = this.navigationService.getState().currentShare
      this.shares = this.navigationService.getState().shares
      this.secret = this.navigationService.getState().secret
      this.required = this.navigationService.getState().required
      this.access = new DefaultSecretAccess(this.navigationService, this.secret, () => { this.shares = [] })
    })
  }

  prev() {
    this.access.assert()
    if (this.currentShare <= 0)
      this.navigationService
        .routeWithState('/social-recovery-generate-rules', {
          shares: this.shares,
          secret: this.secret,
          required: this.required
        })
        .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
    else
      this.navigationService
        .routeWithState('/social-recovery-generate-share-validate', {
          shares: this.shares,
          currentShare: this.currentShare - 1,
          secret: this.secret,
          required: this.required
        })
        .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }

  next() {
    this.access.assert()
    this.navigationService
      .routeWithState('/social-recovery-generate-share-validate', {
        shares: this.shares,
        currentShare: this.currentShare,
        secret: this.secret,
        required: this.required
      })
      .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }
  public ionViewWillEnter(): void { this.access.assert() }
  public ionViewDidEnter(): void { this.deviceService.enableScreenshotProtection({ routeBack: 'social-recovery-generate-share-show' }) }
  public ionViewWillLeave(): void { this.deviceService.disableScreenshotProtection() }
  public ngOnDestroy(): void { this.access?.dispose(); this.shares = [] }
}
