import { AirGapMarketWallet, MainProtocolSymbols } from '@airgap/coinlib-core'
import { Component } from '@angular/core'
import { NavigationService } from 'src/app/services/navigation/navigation.service'
import { BIP32Factory } from '@airgap/coinlib-core/dependencies/src/bip32-5.0.1/src/index'
import * as ecc from '@airgap/coinlib-core/dependencies/src/@bitcoinerlab/secp256k1-1.2.0/src/index'
import bs58check from '@airgap/coinlib-core/dependencies/src/bs58check-4.0.0/src/index'
import { WalletAccessService } from '../../services/wallet-access/wallet-access.service'
import { ErrorCategory, handleErrorLocal } from '../../services/error-handler/error-handler.service'

// https://github.com/satoshilabs/slips/blob/master/slip-0132.md
class ExtendedPublicKey {
  private readonly rawKey: Buffer
  constructor(extendedPublicKey: string) {
    this.rawKey = Buffer.from(bs58check.decode(extendedPublicKey).slice(4))
  }

  toXpub() {
    return this.addPrefix('0488b21e')
  }

  toYPub() {
    return this.addPrefix('049d7cb2')
  }

  toZPub() {
    return this.addPrefix('04b24746')
  }

  private addPrefix(prefix: string) {
    const data = Buffer.concat([Buffer.from(prefix, 'hex'), this.rawKey])
    return bs58check.encode(data)
  }
}

interface AddressInfo {
  address: string
  derivationPath: string
  isExpanded: boolean
}

@Component({
  selector: 'airgap-address-explorer',
  templateUrl: './address-explorer.page.html',
  styleUrls: ['./address-explorer.page.scss']
})
export class AddressExplorerPage {
  private readonly bip32 = BIP32Factory(ecc)
  private contextId?: number
  private revision: number = 0
  private active: boolean = false
  private pendingAddresses?: Promise<void>
  private readonly unregisterCleanup: () => void

  public wallet: AirGapMarketWallet | undefined
  public selectedTab: string = 'external'
  public xpub: string = ''
  public addresses: AddressInfo[] = []

  public showChange: boolean = true
  public loading: boolean = false

  constructor(private readonly navigationService: NavigationService, private readonly access: WalletAccessService) {
    this.unregisterCleanup = this.navigationService.registerSensitiveCleanup(() => this.clearView())
  }

  public get isCurrent(): boolean {
    try {
      if (!this.active || !this.wallet) { return false }
      this.access.assertContext(this.contextId)
      this.access.assertWallet(this.wallet)
      return true
    } catch (_) { return false }
  }

  public async ionViewWillEnter(): Promise<void> {
    this.clearView()
    const wallet: AirGapMarketWallet | undefined = this.navigationService.getState()?.wallet
    if (!wallet) { return }
    this.access.assertWallet(wallet)
    this.contextId = this.access.getContextId()
    this.active = true
    this.wallet = wallet
    const revision = this.revision
    const xpub = this.bip32.fromBase58(new ExtendedPublicKey(wallet.publicKey).toXpub()).toBase58()
    const identifier = await wallet.protocol.getIdentifier()
    if (!this.isCurrent || this.revision !== revision) { return }
    this.xpub = xpub
    this.showChange = identifier !== MainProtocolSymbols.ETH
    await this.clearAddresses()
  }

  public ionViewWillLeave(): void { this.clearView() }

  public ngOnDestroy(): void {
    this.clearView()
    this.unregisterCleanup()
  }

  private clearView(): void {
    this.revision++
    this.active = false
    this.contextId = undefined
    this.wallet = undefined
    this.xpub = ''
    this.addresses = []
    this.selectedTab = 'external'
    this.showChange = true
    this.loading = false
    this.pendingAddresses = undefined
  }

  public async segmentChanged(event: any): Promise<void> {
    if (!this.isCurrent) { return }
    const tab = event.detail.value
    if (tab !== 'external' && (tab !== 'internal' || !this.showChange)) { return }
    this.selectedTab = tab
    await this.clearAddresses()
  }

  public async clearAddresses(): Promise<void> {
    if (!this.isCurrent) { return }
    this.revision++
    this.addresses = []
    this.loading = false
    this.pendingAddresses = undefined
    await this.addAddresses()
  }

  public async loadData(event: any): Promise<void> {
    try {
      await this.addAddresses()
    } catch (error) {
      if (this.isCurrent) { handleErrorLocal(ErrorCategory.OTHER)(error) }
    } finally {
      event.target.complete()
    }
  }

  public toggle(address: AddressInfo): void {
    if (this.isCurrent && this.addresses.includes(address)) { address.isExpanded = !address.isExpanded }
  }

  public async addAddresses(): Promise<void> {
    if (!this.isCurrent || !this.xpub) { return }
    if (this.pendingAddresses) { return this.pendingAddresses }
    const revision = this.revision
    const wallet = this.wallet
    const xpub = this.xpub
    const visibilityIndex = this.selectedTab === 'external' ? 0 : 1
    const nofAddresses = this.addresses.length
    this.loading = true
    const operation = (async () => {
      const batch: AddressInfo[] = []
      for (let i = 0; i < 20; i++) {
        if (!this.isCurrent || this.revision !== revision) { return }
        const index = nofAddresses + i
        const address = (await wallet.protocol.getAddressFromExtendedPublicKey(xpub, visibilityIndex, index)).address
        if (!this.isCurrent || this.revision !== revision) { return }
        batch.push({ address, derivationPath: `${wallet.derivationPath}/${visibilityIndex}/${index}`, isExpanded: false })
      }
      if (this.isCurrent && this.revision === revision) { this.addresses = [...this.addresses, ...batch] }
    })()
    this.pendingAddresses = operation
    try {
      await operation
    } finally {
      if (this.revision === revision) {
        this.pendingAddresses = undefined
        this.loading = false
      }
    }
  }
}
