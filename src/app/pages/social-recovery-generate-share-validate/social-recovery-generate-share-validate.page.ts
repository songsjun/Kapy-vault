import { Component, ViewChild } from '@angular/core'
import { ActivatedRoute } from '@angular/router'
import { IonContent } from '@ionic/angular'
import { MnemonicSecret } from 'src/app/models/secret'
import { ErrorCategory, handleErrorLocal } from 'src/app/services/error-handler/error-handler.service'
import { NavigationService } from 'src/app/services/navigation/navigation.service'
import { SecretsService } from 'src/app/services/secrets/secrets.service'
import { DefaultSecretAccess } from '../../services/navigation/default-secret-access'
import { VerifyKeyAltComponent } from '../../components/verify-key-alt/verify-key-alt.component'

@Component({
  selector: 'airgap-social-recovery-generate-share-validate',
  templateUrl: './social-recovery-generate-share-validate.page.html',
  styleUrls: ['./social-recovery-generate-share-validate.page.scss']
})
export class SocialRecoveryGenerateShareValidatePage {
  @ViewChild(IonContent) content: IonContent
  @ViewChild(VerifyKeyAltComponent) verify: VerifyKeyAltComponent

  public validated: boolean = false
  public currentShare: number = 0
  public shares: string[]

  public isCompleted: boolean = false
  public currentWords: string[] = []
  public promptedWords: string[] = []
  public selectedWordIndex: number | null = null
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
    private readonly secretsService: SecretsService,
    private readonly navigationService: NavigationService,
    route: ActivatedRoute
  ) {
    route.params.subscribe((_) => {
      this.access?.dispose()
      this.currentShare = this.navigationService.getState().currentShare
      this.shares = this.navigationService.getState().shares
      this.secret = this.navigationService.getState().secret
      this.required = this.navigationService.getState().required
      this.access = new DefaultSecretAccess(this.navigationService, this.secret, () => this.clearSensitiveFields())
    })
  }

  public onComplete(isCorrect: boolean) {
    this.validated = isCorrect
  }

  public onNext() {
    if (this.content) this.content.scrollToBottom(500)
  }

  prev() {
    this.access.assert()
    this.navigationService
      .routeWithState('/social-recovery-generate-share-show', {
        shares: this.shares,
        currentShare: this.currentShare,
        secret: this.secret,
        required: this.required
      })
      .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }

  next() {
    this.access.assert()
    if (this.currentShare < this.shares.length - 1)
      this.navigationService
        .routeWithState('/social-recovery-generate-share-show', {
          shares: this.shares,
          currentShare: this.currentShare + 1,
          secret: this.secret,
          required: this.required
        })
        .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
    else {
      this.secret.hasSocialRecovery = true
      this.secretsService
        .addOrUpdateSecret(this.secret)
        .then(() => {
          this.access.assert()
          this.navigationService.routeWithState('/social-recovery-generate-finish', {
            secret: this.secret, shares: this.shares, required: this.required
          }).catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
        })
        .catch(handleErrorLocal(ErrorCategory.SECURE_STORAGE))
    }
  }

  private clearSensitiveFields(): void {
    this.shares = []
    this.currentWords = []
    this.promptedWords = []
    this.validated = false
    if (this.verify) {
      this.verify.secret = ''
      this.verify.splittedSecret = []
      this.verify.currentWords = []
      this.verify.promptedWords = []
    }
  }
  public ionViewWillEnter(): void { this.access.assert() }
  public ngOnDestroy(): void { this.access?.dispose(); this.clearSensitiveFields() }
}
