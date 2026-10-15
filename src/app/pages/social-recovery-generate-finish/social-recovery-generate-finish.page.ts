import { Component } from '@angular/core'
import { ErrorCategory, handleErrorLocal } from 'src/app/services/error-handler/error-handler.service'
import { NavigationService } from 'src/app/services/navigation/navigation.service'
import { DefaultSecretAccess } from '../../services/navigation/default-secret-access'

@Component({
  selector: 'airgap-social-recovery-generate-finish',
  templateUrl: './social-recovery-generate-finish.page.html',
  styleUrls: ['./social-recovery-generate-finish.page.scss']
})
export class SocialRecoveryGenerateFinishPage {
  private required: number
  private shares: string[]
  private readonly access: DefaultSecretAccess

  get numberOfShares(): number {
    return this.shares.length
  }

  get sharesRequired(): number {
    return this.required
  }

  constructor(private readonly navigationService: NavigationService) {
    this.shares = this.navigationService.getState().shares
    this.required = this.navigationService.getState().required
    this.access = new DefaultSecretAccess(this.navigationService, this.navigationService.getState().secret, () => { this.shares = [] })
  }

  next() {
    this.access.assert()
    this.navigationService.route('/tabs/tab-settings').catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }
  public ionViewWillEnter(): void { this.access.assert() }
  public ngOnDestroy(): void { this.access.dispose(); this.shares = [] }
}
