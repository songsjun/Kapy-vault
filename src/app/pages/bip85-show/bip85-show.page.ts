import { Component } from '@angular/core'
import { BIP32Factory, BIP32Interface } from '@airgap/coinlib-core/dependencies/src/bip32-5.0.1/src/index'
import * as ecc from '@airgap/coinlib-core/dependencies/src/@bitcoinerlab/secp256k1-1.2.0/src/index'
import { mnemonicToSeed } from 'bip39'
import { Observable } from 'rxjs'
import { map } from 'rxjs/operators'
import { BIPSigner } from 'src/app/models/BIP39Signer'
import { BIP85 } from '../../models/bip85'
import { MnemonicSecret } from 'src/app/models/secret'
import { DeviceService } from 'src/app/services/device/device.service'
import { ErrorCategory, handleErrorLocal } from 'src/app/services/error-handler/error-handler.service'
import { LifehashService } from 'src/app/services/lifehash/lifehash.service'
import { NavigationService } from 'src/app/services/navigation/navigation.service'
import { SecretsService } from 'src/app/services/secrets/secrets.service'
import { AdvancedModeType, VaultStorageKey, VaultStorageService } from 'src/app/services/storage/storage.service'
import { DefaultSecretAccess } from '../../services/navigation/default-secret-access'

@Component({
  selector: 'airgap-bip85-show',
  templateUrl: './bip85-show.page.html',
  styleUrls: ['./bip85-show.page.scss']
})
export class Bip85ShowPage {
  private secret: MnemonicSecret
  public mnemonicLength: 12 | 18 | 24
  public index: number
  private readonly bip32 = BIP32Factory(ecc)
  private access: DefaultSecretAccess

  public childMnemonic: string | undefined
  public childFingerprint: string | undefined
  public lifehashData: string | undefined

  public bip39Passphrase: string = ''

  public isBlurred: boolean = true
  blurText =
    '****** **** ***** **** ******* ***** ***** ****** ***** *** ***** ******* ***** **** ***** ********* ***** ****** ***** **** ***** ******* ***** ****'

  public isAdvancedMode$: Observable<boolean> = this.storageService
    .subscribe(VaultStorageKey.ADVANCED_MODE_TYPE)
    .pipe(map((res) => res === AdvancedModeType.ADVANCED))

  constructor(
    private readonly deviceService: DeviceService,
    private readonly navigationService: NavigationService,
    private readonly secretsService: SecretsService,
    private readonly lifehashService: LifehashService,
    private readonly storageService: VaultStorageService
  ) {
    if (this.navigationService.getState()) {
      this.secret = this.navigationService.getState().secret
      this.mnemonicLength = this.navigationService.getState().mnemonicLength
      this.index = this.navigationService.getState().index
      this.bip39Passphrase = this.navigationService.getState().bip39Passphrase
      this.access = new DefaultSecretAccess(this.navigationService, this.secret, () => this.clearSensitiveFields())

      this.generateChildMnemonic(this.secret, this.mnemonicLength, this.index).catch((error) => {
        this.clearSensitiveFields()
        try { this.access.assert() } catch (_) { return }
        handleErrorLocal(ErrorCategory.SECURE_STORAGE)(error)
      })
    }
  }

  public ionViewDidEnter(): void {
    this.access.assert()
    this.deviceService.enableScreenshotProtection({ routeBack: 'bip85-show' })
  }

  public ionViewWillLeave(): void {
    this.deviceService.disableScreenshotProtection()
  }

  public goToSecretSetupPage(): void {
    this.access.assert()
    const signer: BIPSigner = new BIPSigner()

    const secret: MnemonicSecret = new MnemonicSecret(signer.mnemonicToEntropy(BIPSigner.prepareMnemonic(this.childMnemonic)))

    this.navigationService
      .routeWithState('secret-add', { secret: new MnemonicSecret(secret.secretHex, `BIP85 child of "${this.secret.label}"`) })
      .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }

  public timeout: NodeJS.Timer

  changeBlur() {
    this.access.assert()
    this.isBlurred = !this.isBlurred

    if (this.timeout) {
      clearTimeout(this.timeout)
    }

    this.timeout = setTimeout(() => {
      this.isBlurred = true
    }, 30_000)
  }

  private async generateChildMnemonic(secret: MnemonicSecret, length: 12 | 18 | 24, index: number) {
    this.access.assert()
    try {
      const secretHex = await this.secretsService.retrieveEntropyForSecret(secret)
      this.access.assert()

      const masterSeed = BIP85.fromEntropy(secretHex, this.bip39Passphrase)

      const childEntropy = masterSeed.deriveBIP39(0, length, index)

      const childMnemonic = childEntropy.toMnemonic()

      const seed: Buffer = await mnemonicToSeed(childMnemonic)
      this.access.assert()
      const bip32Node: BIP32Interface = this.bip32.fromSeed(new Uint8Array(seed))
      seed.fill(0)
      const lifehash = await this.lifehashService.generateLifehash(new Uint8Array(bip32Node.fingerprint))
      this.access.assert()
      this.childMnemonic = childMnemonic
      this.childFingerprint = Buffer.from(bip32Node.fingerprint).toString('hex')
      this.lifehashData = lifehash
    } catch (error) {
      throw error
    }
  }

  private clearSensitiveFields(): void {
    clearTimeout(this.timeout)
    this.isBlurred = true
    this.childMnemonic = undefined
    this.childFingerprint = undefined
    this.lifehashData = undefined
    this.bip39Passphrase = ''
  }

  public ngOnDestroy(): void {
    this.access?.dispose()
    this.clearSensitiveFields()
  }
}
