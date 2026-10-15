import { AirGapWallet, AirGapWalletStatus, MainProtocolSymbols } from '@airgap/coinlib-core'
import { Component } from '@angular/core'
import { ModalController, NavParams } from '@ionic/angular'
import { TranslateService } from '@ngx-translate/core'
import { WalletAccessService } from '../../services/wallet-access/wallet-access.service'

@Component({ selector: 'airgap-select-account', templateUrl: './select-account.page.html', styleUrls: ['./select-account.page.scss'] })
export class SelectAccountPage {
  public title: string
  public heading: string
  public placeholder: string
  public wallets: AirGapWallet[] = []
  public symbolFilter: MainProtocolSymbols | undefined
  private contextId: number

  constructor(
    private readonly access: WalletAccessService,
    private readonly translateService: TranslateService,
    private readonly navParams: NavParams,
    private readonly modalController: ModalController
  ) {}

  public async ngOnInit(): Promise<void> {
    this.contextId = this.access.getContextId()
    const type = this.navParams.get('type') === 'message-account' ? 'message-signing' : this.navParams.get('type')
    this.title = this.translateService.instant(`select-account.${type}.title`)
    this.heading = this.translateService.instant(`select-account.${type}.heading`)
    this.placeholder = this.translateService.instant(`select-account.${type}.placeholder`)
    this.symbolFilter = this.navParams.get('symbolFilter') ?? this.symbolFilter
    const candidates = await Promise.all(this.access.getWallets().map(async (wallet) => {
      const identifier = await wallet.protocol.getIdentifier()
      return wallet.status === AirGapWalletStatus.ACTIVE &&
        (!this.symbolFilter || identifier === this.symbolFilter || this.symbolFilter.startsWith(identifier)) ? wallet : undefined
    }))
    this.access.assertContext(this.contextId)
    this.wallets = candidates.filter((wallet) => wallet !== undefined)
  }

  public async setWallet(wallet: AirGapWallet): Promise<void> {
    this.access.assertContext(this.contextId)
    this.access.assertWallet(wallet)
    // Every caller receives the selected account, never an unbound protocol name.
    await this.modalController.dismiss(wallet)
  }

  public async dismiss(): Promise<void> { await this.modalController.dismiss() }
}
