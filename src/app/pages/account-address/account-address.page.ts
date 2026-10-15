import { ClipboardService, DeeplinkService, QRType, UiEventService } from '@airgap/angular-core'
import { AirGapWallet, MainProtocolSymbols, ProtocolSymbols } from '@airgap/coinlib-core'
import { IACMessageDefinitionObjectV3 } from '@airgap/serializer'
import { Component, OnDestroy, ViewChild } from '@angular/core'
import { Router } from '@angular/router'
import { IonModal, PopoverController } from '@ionic/angular'
import { Observable } from 'rxjs'
import { map } from 'rxjs/operators'
import { MnemonicSecret } from 'src/app/models/secret'
import { AdvancedModeType, VaultStorageKey, VaultStorageService } from 'src/app/services/storage/storage.service'

import { ErrorCategory, handleErrorLocal } from '../../services/error-handler/error-handler.service'
import { InteractionOperationType, InteractionService } from '../../services/interaction/interaction.service'
import { MigrationService } from '../../services/migration/migration.service'
import { NavigationService } from '../../services/navigation/navigation.service'
import { ShareUrlService } from '../../services/share-url/share-url.service'
import { isWalletMigrated } from '../../utils/migration'

import { AccountEditPopoverComponent } from './account-edit-popover/account-edit-popover.component'
import { WalletAccessService } from '../../services/wallet-access/wallet-access.service'

// TODO: add wallet definition into a service
export const airgapwallet = {
  icon: 'airgap-wallet-app-logo.svg',
  name: 'AirGap Wallet',
  qrType: QRType.V3
}

const bluewallet = {
  icon: 'bluewallet.png',
  name: 'BlueWallet',
  qrType: QRType.BC_UR
}

const sparrowwallet = {
  icon: 'sparrowwallet.png',
  name: 'Sparrow Wallet',
  qrType: QRType.BC_UR
}

const specterwallet = {
  icon: 'specterwallet.png',
  name: 'Specter Wallet',
  qrType: QRType.BC_UR
}

const nunchukwallet = {
  icon: 'nunchuk.png',
  name: 'Nunchuk Wallet',
  qrType: QRType.BC_UR
}

const metamask = {
  icon: 'metamask.webp',
  name: 'MetaMask',
  qrType: QRType.METAMASK
}

const imtoken = {
  icon: 'imtoken-wallet.svg',
  name: 'imToken',
  qrType: QRType.METAMASK
}

const rabby = {
  icon: 'rabby-wallet.svg',
  name: 'Rabby',
  qrType: QRType.METAMASK
}

export const superherowallet = {
  icon: 'superhero-wallet.png',
  name: 'Superhero Wallet',
  qrType: QRType.V3,
  urlScheme: 'superhero'
}

export interface CompanionApp {
  icon: string
  name: string
  qrType: QRType
  urlScheme?: string
}

@Component({
  selector: 'airgap-account-address',
  templateUrl: './account-address.page.html',
  styleUrls: ['./account-address.page.scss']
})
export class AccountAddressPage implements OnDestroy {
  private contextId: number
  private revision = 0
  private active = false
  private editPopover?: HTMLIonPopoverElement
  private readonly unregisterCleanup: () => void

  public get canView(): boolean {
    try { this.assertCurrent(); return true } catch { return false }
  }

  @ViewChild(IonModal) modal: IonModal

  public wallet: AirGapWallet
  public protocolSymbol: string
  public protocolIdentifier: ProtocolSymbols
  public protocolName: string
  public secret: MnemonicSecret

  public syncOptions: CompanionApp[]

  public showMetaMaskMigrationOnboarding: boolean = false

  public isAppAdvancedMode$: Observable<boolean> = this.storageService
    .subscribe(VaultStorageKey.ADVANCED_MODE_TYPE)
    .pipe(map((res) => res === AdvancedModeType.ADVANCED))

  private shareObject?: IACMessageDefinitionObjectV3[]
  private shareObjectPromise?: Promise<void>
  private walletShareUrl?: string

  presentingElement = null

  constructor(
    private readonly popoverCtrl: PopoverController,
    private readonly clipboardService: ClipboardService,
    private readonly shareUrlService: ShareUrlService,
    private readonly interactionService: InteractionService,
    private readonly navigationService: NavigationService,
    private readonly uiEventService: UiEventService,
    private readonly migrationService: MigrationService,
    private readonly deepLinkService: DeeplinkService,
    private readonly storageService: VaultStorageService,
    private readonly router: Router,
    private readonly access: WalletAccessService
  ) {
    this.unregisterCleanup = this.navigationService.registerSensitiveCleanup(() => this.clearView())
  }

  public ngOnInit(): void {
    this.presentingElement = typeof document === 'undefined' ? null : document.querySelector('.ion-page')
  }

  public ionViewWillEnter(): void {
    this.clearView()
    try {
      const state = this.navigationService.getState()
      this.contextId = this.access.getContextId()
      this.wallet = state.wallet
      this.secret = state.secret
      this.active = true
      this.assertCurrent()
    } catch {
      this.clearView()
      this.router.navigate(['/'])
      return
    }
    this.loadProtocolDetails(this.revision).catch(() => undefined)
  }

  public ionViewDidLeave(): void { this.clearView() }
  public ngOnDestroy(): void { this.clearView(); this.unregisterCleanup() }

  private assertCurrent(revision = this.revision): number {
    if (!this.active || revision !== this.revision || !this.wallet) throw new Error('This account view is closed.')
    this.access.assertContext(this.contextId)
    this.access.assertWallet(this.wallet, this.secret)
    return this.contextId
  }

  private clearView(): void {
    this.active = false
    this.revision++
    this.wallet = undefined
    this.secret = undefined
    this.protocolName = undefined
    this.protocolIdentifier = undefined
    this.protocolSymbol = undefined
    this.syncOptions = []
    this.showMetaMaskMigrationOnboarding = false
    this.shareObject = undefined
    this.shareObjectPromise = undefined
    this.walletShareUrl = undefined
    const popover = this.editPopover
    this.editPopover = undefined
    popover?.dismiss().catch(() => undefined)
    this.modal?.dismiss().catch(() => undefined)
  }

  private async loadProtocolDetails(revision: number): Promise<void> {
    if (this.wallet) {
      const [protocolSymbol, protocolIdentifier, protocolName] = await Promise.all([
        this.wallet.protocol.getSymbol(),
        this.wallet.protocol.getIdentifier(),
        this.wallet.protocol.getName()
      ])

      this.assertCurrent(revision)
      this.protocolSymbol = protocolSymbol
      this.protocolIdentifier = protocolIdentifier
      this.protocolName = protocolName

      switch (protocolIdentifier) {
        case MainProtocolSymbols.BTC:
        case MainProtocolSymbols.BTC_SEGWIT:
          this.syncOptions = [airgapwallet, bluewallet, sparrowwallet, specterwallet, nunchukwallet]
          break
        case MainProtocolSymbols.BTC_TAPROOT:
          this.syncOptions = [airgapwallet, sparrowwallet]
          break
        case MainProtocolSymbols.ETH:
        case MainProtocolSymbols.OPTIMISM:
        case MainProtocolSymbols.BNB:
        case MainProtocolSymbols.BASE:
          this.syncOptions = [airgapwallet]
          if (this.wallet.isExtendedPublicKey) {
            this.syncOptions.push(metamask, imtoken, rabby)
          } else {
            this.showMetaMaskMigrationOnboarding = true
          }
          break
        case MainProtocolSymbols.AE:
          this.syncOptions = [airgapwallet, superherowallet]
          break

        default:
          this.syncOptions = [airgapwallet]
      }
    }
  }

  public done(): void {
    const contextId = this.assertCurrent()
    this.navigationService.routeWithState('/accounts-list', { secret: this.secret, contextId }).catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }

  public async share(companionApp: CompanionApp = airgapwallet): Promise<void> {
    const revision = this.revision
    const contextId = this.assertCurrent(revision)
    await this.waitWalletShareUrl()
    this.assertCurrent(revision)
    await this.interactionService.startInteraction({
      contextId, operationType: InteractionOperationType.WALLET_SYNC, iacMessage: this.shareObject, companionApp
    })
  }

  public async presentEditPopover(event: Event): Promise<void> {
    const revision = this.revision
    const contextId = this.assertCurrent(revision)
    const popover = await this.popoverCtrl.create({
      component: AccountEditPopoverComponent,
      componentProps: {
        wallet: this.wallet,
        contextId,
        openAddressQR: async () => {
          this.assertCurrent(revision)
          await this.modal.present()
          try { this.assertCurrent(revision) } catch (error) { this.modal?.dismiss().catch(() => undefined); throw error }
        },
        getWalletShareUrl: async () => {
          this.assertCurrent(revision)
          await this.waitWalletShareUrl()
          this.assertCurrent(revision)
          return this.walletShareUrl
        },
        onDelete: (): void => {
          this.access.assertContext(contextId)
          if (this.active && this.revision === revision) this.navigationService.back()
        }
      },
      event,
      translucent: true
    })
    try { this.assertCurrent(revision) } catch (error) { popover.dismiss().catch(() => undefined); throw error }
    this.editPopover = popover
    await popover.present()
    try { this.assertCurrent(revision) } catch (error) { popover.dismiss().catch(() => undefined); throw error }
  }

  public async copyAddressToClipboard(): Promise<void> {
    this.assertCurrent()
    await this.clipboardService.copyAndShowToast(this.wallet.receivingPublicAddress)
  }

  private async waitWalletShareUrl(): Promise<void> {
    const revision = this.revision
    this.assertCurrent(revision)
    await this.prepareSyncObject()
    this.assertCurrent(revision)
    const walletShareUrl = await this.deepLinkService.generateDeepLinkUrl(this.shareObject)
    this.assertCurrent(revision)
    this.walletShareUrl = walletShareUrl
  }

  private async prepareSyncObject(): Promise<void> {
    const revision = this.revision
    this.assertCurrent(revision)
    if (this.shareObject !== undefined) return
    if (this.shareObjectPromise !== undefined) return this.shareObjectPromise
    const wallet = this.wallet
    const pending = (async () => {
      await this.migrationService.runWalletsMigration([wallet])
      this.assertCurrent(revision)
      if (!isWalletMigrated(wallet)) {
        await this.showWalletNotMigratedAlert()
        this.assertCurrent(revision)
        throw new Error('Cannot create share URL, wallet data is incomplete')
      }
      const shareObject = await this.shareUrlService.generateShareWalletURL(wallet)
      this.assertCurrent(revision)
      this.shareObject = shareObject
    })()
    this.shareObjectPromise = pending
    try { await pending } finally {
      if (this.shareObjectPromise === pending) this.shareObjectPromise = undefined
    }
  }

  private async showWalletNotMigratedAlert(): Promise<void> {
    this.assertCurrent()
    return this.uiEventService.showTranslatedAlert({
      header: 'wallet-address.alert.wallet-not-migrated.header',
      message: 'wallet-address.alert.wallet-not-migrated.message',
      buttons: [{ text: 'wallet-address.alert.wallet-not-migrated.button_label' }]
    })
  }
}
