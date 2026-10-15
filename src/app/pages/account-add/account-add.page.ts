import { Component } from '@angular/core'
import { ModalController } from '@ionic/angular'
import { ICoinProtocol, ProtocolSymbols } from '@airgap/coinlib-core'

import { ErrorCategory, handleErrorLocal } from '../../services/error-handler/error-handler.service'
import { NavigationService } from '../../services/navigation/navigation.service'
import { SecretsService } from '../../services/secrets/secrets.service'
import { AdvancedModeType, VaultStorageKey, VaultStorageService } from '../../services/storage/storage.service'
import { LocalAuthenticationOnboardingPage } from '../local-authentication-onboarding/local-authentication-onboarding.page'
import { ProtocolService } from '@airgap/angular-core'
import { MnemonicSecret } from 'src/app/models/secret'
import { Observable, Subscription } from 'rxjs'
import { map } from 'rxjs/operators'
import { WalletAccessService } from '../../services/wallet-access/wallet-access.service'

interface ProtocolWrapper {
  protocol: ICoinProtocol
  isHDWallet: boolean
  isChecked: boolean
  customDerivationPath: string | undefined
  details: ProtocolDetails
}

interface ProtocolDetails {
  symbol: string
  identifier: ProtocolSymbols
  name: string
}

@Component({
  selector: 'airgap-account-add',
  templateUrl: './account-add.page.html',
  styleUrls: ['./account-add.page.scss']
})
export class AccountAddPage {
  public secret: MnemonicSecret
  public selectedProtocol: ICoinProtocol
  public formValid: boolean = false
  public protocolList: ProtocolWrapper[]
  public protocolDetails: ProtocolDetails[]
  public isHDWallet: boolean = false

  singleSelectedProtocol: ProtocolWrapper | undefined

  public isAdvancedMode: boolean = false
  public adding: boolean = false
  private active: boolean = false
  private revision: number = 0
  private selectionRevision: number = 0
  private readonly accessSubscription: Subscription

  public get canAdd(): boolean {
    return this.active && !!this.secret && this.walletAccess.isUnlocked(this.secret)
  }

  public isAppAdvancedMode$: Observable<boolean> = this.storageService
    .subscribe(VaultStorageKey.ADVANCED_MODE_TYPE)
    .pipe(map((res) => res === AdvancedModeType.ADVANCED))

  constructor(
    private readonly secretsService: SecretsService,
    private readonly storageService: VaultStorageService,
    private readonly protocolService: ProtocolService,
    private readonly modalController: ModalController,
    private readonly navigationService: NavigationService,
    public readonly walletAccess: WalletAccessService
  ) {
    const state = this.navigationService.getState()
    this.secret = state?.secret
    this.accessSubscription = this.walletAccess.changes$.subscribe(() => {
      if (this.active && !this.canAdd) {
        this.denyAccess()
      }
    })
  }

  private denyAccess(): void {
    this.active = false
    this.revision++
    this.formValid = false
    this.protocolList = []
    this.singleSelectedProtocol = undefined
    this.navigationService.routeToSecretsTab().catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }

  public ionViewDidLeave(): void {
    this.active = false
    this.revision++
    this.formValid = false
    this.protocolList = []
    this.singleSelectedProtocol = undefined
  }

  public ngOnDestroy(): void {
    this.ionViewDidLeave()
    this.accessSubscription.unsubscribe()
  }

  public ionViewWillEnter(): void {
    this.active = true
    const state = this.navigationService.getState()
    const currentSecret = this.walletAccess.getCurrentSecret()
    if (!state?.secret || !currentSecret || state.secret.id !== currentSecret.id || !this.walletAccess.isUnlocked(currentSecret)) {
      this.denyAccess()
      return
    }
    this.secret = currentSecret
    const revision = ++this.revision
    this.protocolService.getActiveProtocols().then(async (protocols: ICoinProtocol[]) => {
      if (!this.canAdd || revision !== this.revision) {
        return
      }
      const navigationIdentifier: ProtocolSymbols | undefined = state.protocol

      const protocolList = await Promise.all(
        protocols.map(async (protocol) => {
          const [symbol, identifier, name, supportsHD] = await Promise.all([
            protocol.getSymbol(),
            protocol.getIdentifier(),
            protocol.getName(),
            protocol.getSupportsHD()
          ])
          const isChecked = navigationIdentifier === identifier

          return {
            protocol,
            isHDWallet: supportsHD,
            customDerivationPath: undefined,
            isChecked: isChecked,
            details: { symbol, identifier, name }
          }
        })
      )
      if (this.canAdd && revision === this.revision) {
        this.protocolList = protocolList
        this.onProtocolSelected()
      }
    }).catch(handleErrorLocal(ErrorCategory.SECURE_STORAGE))
  }

  public onProtocolSelected(): void {
    if (!this.canAdd) {
      return
    }
    const revision = this.revision
    const selectionRevision = ++this.selectionRevision
    this.formValid = false
    // Ionic updates the checkbox value after its click handler.
    setTimeout(() => {
      this.prepareSelectedProtocols(revision, selectionRevision).catch((error) => {
        if (this.canAdd) {
          handleErrorLocal(ErrorCategory.SECURE_STORAGE)(error)
        }
      })
    }, 0)
  }

  private async prepareSelectedProtocols(revision: number, selectionRevision: number): Promise<void> {
    if (!this.canAdd || revision !== this.revision || selectionRevision !== this.selectionRevision) {
      return
    }
    const selected = this.protocolList.filter((protocol) => protocol.isChecked)
    const advanced = this.isAdvancedMode
    const prepared = await Promise.all(selected.map(async (wrapper) => {
      const next = advanced
        ? {
            derivationPath: selected.length === 1 ? await wrapper.protocol.getStandardDerivationPath() : undefined,
            isHDWallet: await wrapper.protocol.getSupportsHD()
          }
        : await this.secretsService.getNextDerivationPathForProtocol(wrapper.protocol, this.secret)
      return { wrapper, next }
    }))
    if (!this.canAdd || revision !== this.revision || selectionRevision !== this.selectionRevision) {
      return
    }
    for (const { wrapper, next } of prepared) {
      wrapper.customDerivationPath = next.derivationPath
      wrapper.isHDWallet = next.isHDWallet
    }
    this.singleSelectedProtocol = selected.length === 1 ? selected[0] : undefined
    this.formValid = selected.length > 0
  }

  public async toggleHDWallet(): Promise<void> {
    if (!this.canAdd) {
      return
    }
    const revision = this.revision
    const selectionRevision = ++this.selectionRevision
    const selected = this.protocolList.filter((protocol) => protocol.isChecked)
    if (selected.length !== 1) {
      this.singleSelectedProtocol = undefined
      return
    }
    const wrapper = selected[0]
    const [path, supportsHD] = await Promise.all([wrapper.protocol.getStandardDerivationPath(), wrapper.protocol.getSupportsHD()])
    if (!this.canAdd || revision !== this.revision || selectionRevision !== this.selectionRevision) {
      return
    }
    wrapper.customDerivationPath = supportsHD && wrapper.isHDWallet ? path : `${path}/0/0`
    this.singleSelectedProtocol = wrapper
  }

  public async addWallet(): Promise<void> {
    if (!this.canAdd || !this.formValid || this.adding) {
      return
    }
    const value: boolean = await this.storageService.get(VaultStorageKey.DISCLAIMER_HIDE_LOCAL_AUTH_ONBOARDING)
    if (!this.canAdd) {
      return
    }
    if (!value) {
      const modal: HTMLIonModalElement = await this.modalController.create({ component: LocalAuthenticationOnboardingPage })
      modal.onDidDismiss().then(() => {
        if (this.canAdd) {
          this.addWalletAndReturnToAddressPage().catch(handleErrorLocal(ErrorCategory.SECURE_STORAGE))
        }
      }).catch(handleErrorLocal(ErrorCategory.IONIC_MODAL))
      if (this.canAdd) {
        await modal.present()
      }
    } else {
      await this.addWalletAndReturnToAddressPage()
    }
  }

  private async addWalletAndReturnToAddressPage(): Promise<void> {
    if (!this.canAdd || this.adding) {
      return
    }
    this.adding = true
    const revision = this.revision
    try {
      const selectedProtocols = this.protocolList.filter((protocol) => protocol.isChecked)
      const configs = await Promise.all(selectedProtocols.map(async (wrapper: ProtocolWrapper) => ({
        protocolIdentifier: await wrapper.protocol.getIdentifier(),
        isHDWallet: wrapper.isHDWallet,
        customDerivationPath: wrapper.customDerivationPath ?? (await wrapper.protocol.getStandardDerivationPath()),
        isActive: true
      })))
      if (!this.canAdd || revision !== this.revision) {
        return
      }
      const createdWallets = await this.secretsService.addWallets(this.secret, configs)
      if (!this.canAdd || revision !== this.revision) {
        return
      }
      if (createdWallets.length === 1) {
        await this.navigationService.routeWithState('/account-address', { wallet: createdWallets[0], secret: this.secret }, { replaceUrl: true })
      } else {
        await this.navigationService.routeWithState('/accounts-list', { secret: this.secret }, { replaceUrl: true })
      }
    } catch (error) {
      handleErrorLocal(ErrorCategory.SECURE_STORAGE)(error)
    } finally {
      this.adding = false
    }
  }

  public goToIsolatedModule(): void {
    if (!this.canAdd) {
      return
    }
    this.navigationService.route('/isolated-modules-list').catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }
}
