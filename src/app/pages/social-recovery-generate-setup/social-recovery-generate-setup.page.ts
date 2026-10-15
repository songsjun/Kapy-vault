import { Component } from '@angular/core'
import { MnemonicSecret } from 'src/app/models/secret'
import { ErrorCategory, handleErrorLocal } from 'src/app/services/error-handler/error-handler.service'
import { NavigationService } from 'src/app/services/navigation/navigation.service'
import { SecretsService } from 'src/app/services/secrets/secrets.service'
import * as bip39 from 'bip39'
import { DefaultSecretAccess } from '../../services/navigation/default-secret-access'

@Component({
  selector: 'airgap-social-recovery-generate-setup',
  templateUrl: './social-recovery-generate-setup.page.html',
  styleUrls: ['./social-recovery-generate-setup.page.scss']
})
export class SocialRecoveryGenerateSetupPage {
  public state: 0 | 1 = 0
  public numberOfShares: number = -1
  public numberOfRequiredShares: number = -1
  private readonly secret: MnemonicSecret
  private readonly access: DefaultSecretAccess

  get numberSharesArray(): number[] {
    const arr = []
    for (let i = 2; i <= this.numberOfShares; i++) {
      arr.push(i)
    }
    return arr
  }
  constructor(private readonly secretService: SecretsService, private readonly navigationService: NavigationService) {
    this.secret = this.navigationService.getState().secret
    this.access = new DefaultSecretAccess(this.navigationService, this.secret, () => { this.state = 0 })
  }

  public setNumberOfShares(i: number): void {
    this.numberOfShares = i
    if (this.numberOfRequiredShares > this.numberOfShares) {
      this.numberOfRequiredShares = this.numberOfShares
    }
  }

  public setNumberOfRequiredShares(i: number): void {
    this.numberOfRequiredShares = i
  }

  nextState() {
    this.access.assert()
    if (this.state === 0) {
      this.state++
      return
    } else if (this.state === 1) {
      this.secretService
        .retrieveEntropyForSecret(this.secret)
        .then((entropy) => {
          this.access.assert()
          const shares: string[] = MnemonicSecret.generateSocialRecover(
            bip39.entropyToMnemonic(entropy),
            this.numberOfShares,
            this.numberOfRequiredShares
          )
          this.navigationService
            .routeWithState('/social-recovery-generate-rules', { shares, secret: this.secret, required: this.numberOfRequiredShares })
            .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
        })
        .catch((error) => {
          console.warn(error)
        })
    }
  }
  public ionViewWillEnter(): void { this.access.assert() }
  public ngOnDestroy(): void { this.access.dispose() }
}
