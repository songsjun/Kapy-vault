import { PermissionsService, QrScannerService } from '@airgap/angular-core'
import { Component, Inject, NgZone, ViewChild } from '@angular/core'
import { Platform } from '@ionic/angular'
import { ZXingScannerComponent } from '@zxing/ngx-scanner'
import { UREncoder } from '@ngraveio/bc-ur'
import { Subscription } from 'rxjs'

import { SecurityUtilsPlugin } from '../../capacitor-plugins/definitions'
import { SECURITY_UTILS_PLUGIN } from '../../capacitor-plugins/injection-tokens'
import {
  BitcoinMultisigCosigner, BitcoinMultisigNetwork, BitcoinMultisigScript,
  BitcoinMultisigReview, inspectMultisigPsbt
} from '../../services/bitcoin-multisig/bitcoin-multisig'
import { MultisigPsbtQrDecoder, multisigCosignerEncoder, multisigPsbtEncoder } from '../../services/bitcoin-multisig/bitcoin-multisig-qr'
import { BitcoinMultisigService } from '../../services/bitcoin-multisig/bitcoin-multisig.service'
import { NavigationService } from '../../services/navigation/navigation.service'
import { WalletAccessService } from '../../services/wallet-access/wallet-access.service'
import { ScanBasePage } from '../scan-base/scan-base'

@Component({
  selector: 'airgap-bitcoin-multisig',
  templateUrl: './bitcoin-multisig.page.html',
  styleUrls: ['./bitcoin-multisig.page.scss']
})
export class BitcoinMultisigPage extends ScanBasePage {
  @ViewChild('scanner') public zxingScanner?: ZXingScannerComponent

  public network: BitcoinMultisigNetwork = 'mainnet'
  public scriptType: BitcoinMultisigScript = 'p2wsh'
  public account = 0
  public stage: 'setup' | 'scan' | 'review' | 'export' | 'signed' = 'setup'
  public review?: BitcoinMultisigReview
  public cosigner?: BitcoinMultisigCosigner
  public qrData = ''
  public qrParts = 0
  public progress = 0
  public busy = false
  public errorKey = ''
  public addedSignatures = 0
  public alreadySignedInputs = 0
  public hasScannedRequest = false

  private contextId: number
  private active = false
  private revision = 0
  private requestPsbt?: string
  private decoder?: MultisigPsbtQrDecoder
  private animation?: ReturnType<typeof setInterval>
  private cameraStart?: ReturnType<typeof setTimeout>
  private readonly subscription: Subscription
  private readonly unregisterCleanup: () => void

  constructor(
    platform: Platform,
    scanner: QrScannerService,
    permissions: PermissionsService,
    @Inject(SECURITY_UTILS_PLUGIN) security: SecurityUtilsPlugin,
    private readonly access: WalletAccessService,
    private readonly multisig: BitcoinMultisigService,
    private readonly navigation: NavigationService,
    private readonly zone: NgZone
  ) {
    super(platform, scanner, permissions, security)
    this.subscription = this.access.changes$.subscribe(() => {
      if (this.active) {
        try { this.access.assertContext(this.contextId) } catch { this.deactivate() }
      }
    })
    this.unregisterCleanup = this.navigation.registerSensitiveCleanup(() => this.deactivate())
  }

  public async ionViewWillEnter(): Promise<void> {
    this.clear()
    const state = this.navigation.getState()
    this.contextId = state.contextId ?? this.access.getContextId()
    this.access.assertContext(this.contextId)
    this.active = true
    if (typeof state.psbtHex === 'string') {
      this.requestPsbt = state.psbtHex
      this.hasScannedRequest = true
      delete state.psbtHex
    }
  }

  // Camera activation is explicit; simply opening this page never starts scanning.
  public ionViewDidEnter(): void {}

  public ionViewWillLeave(): void { this.deactivate() }

  public ngOnDestroy(): void {
    this.deactivate()
    this.subscription.unsubscribe()
    this.unregisterCleanup()
  }

  public configurationChanged(): void {
    if (this.busy) return
    this.revision++
    this.review = undefined
    this.cosigner = undefined
    this.errorKey = ''
    this.stopAnimation()
    if (this.scriptType === 'p2sh') this.account = 0
  }

  public async exportCosigner(): Promise<void> {
    if (this.busy || !this.active) return
    const revision = ++this.revision
    const contextId = this.contextId
    const network = this.network
    const scriptType = this.scriptType
    const account = Number(this.account)
    this.busy = true
    this.errorKey = ''
    try {
      const cosigner = await this.multisig.exportCosigner(contextId, network, scriptType, account)
      if (!this.isCurrent(revision)) return
      const encoder = multisigCosignerEncoder(cosigner)
      this.cosigner = cosigner
      this.stage = 'export'
      this.animate(encoder)
    } catch {
      if (this.isCurrent(revision)) this.errorKey = 'bitcoin-multisig.export-error'
    } finally {
      if (this.isCurrent(revision)) this.busy = false
    }
  }

  public startPsbtScan(): void {
    if (this.busy || !this.active) return
    this.clear()
    this.stage = 'scan'
    this.decoder = new MultisigPsbtQrDecoder()
    // Ionic must render the scanner before ScanBasePage tries to activate it.
    this.cameraStart = setTimeout(async () => {
      this.cameraStart = undefined
      if (!this.active || this.stage !== 'scan') return
      try {
        await super.ionViewWillEnter()
        if (this.active && this.stage === 'scan') super.ionViewDidEnter()
        else this.stopScan()
      } catch {
        if (this.active) {
          this.stopScan()
          this.stage = 'setup'
          this.errorKey = 'bitcoin-multisig.scan-error'
        }
      }
    }, 0)
  }

  public startScan(): void {
    if (this.active && this.stage === 'scan') super.startScan()
  }

  public async checkScan(frame: string): Promise<void> {
    if (!this.active || this.stage !== 'scan' || !this.decoder) return
    this.zone.run(() => {
      try {
        const result = this.decoder.receive(frame)
        this.progress = result.progress
        if (result.psbtHex) {
          this.stopScan()
          this.decoder = undefined
          this.requestPsbt = result.psbtHex
          this.hasScannedRequest = true
          this.reviewRequest()
        } else this.startScan()
      } catch {
        this.clear()
        this.errorKey = 'bitcoin-multisig.scan-error'
      }
    })
  }

  public reviewRequest(): void {
    if (!this.active || !this.requestPsbt || this.busy) return
    try {
      this.access.assertContext(this.contextId)
      this.review = inspectMultisigPsbt(this.requestPsbt, this.network)
      this.stage = 'review'
      this.errorKey = ''
    } catch {
      this.review = undefined
      this.stage = 'setup'
      this.errorKey = 'bitcoin-multisig.review-error'
    }
  }

  public async sign(): Promise<void> {
    if (this.busy || !this.active || this.stage !== 'review' || !this.review || !this.requestPsbt) return
    if (this.network !== this.review.network) {
      this.errorKey = 'bitcoin-multisig.review-error'
      return
    }
    const revision = ++this.revision
    const psbt = this.requestPsbt
    const network = this.network
    const contextId = this.contextId
    this.busy = true
    this.errorKey = ''
    try {
      const result = await this.multisig.sign(contextId, psbt, network)
      if (!this.isCurrent(revision)) return
      const encoder = multisigPsbtEncoder(result.psbtHex)
      this.addedSignatures = result.addedSignatures
      this.alreadySignedInputs = result.alreadySignedInputs
      this.requestPsbt = undefined
      this.hasScannedRequest = false
      this.stage = 'signed'
      this.animate(encoder)
    } catch {
      if (this.isCurrent(revision)) this.errorKey = 'bitcoin-multisig.sign-error'
    } finally {
      if (this.isCurrent(revision)) this.busy = false
    }
  }

  public reset(): void { this.clear() }

  public async done(): Promise<void> {
    this.access.assertContext(this.contextId)
    const secret = this.access.getCurrentSecret()
    this.deactivate()
    await this.navigation.routeWithState('/accounts-list', { contextId: this.contextId, secret })
  }

  private isCurrent(revision: number): boolean {
    if (!this.active || revision !== this.revision) return false
    try { this.access.assertContext(this.contextId); return true } catch { return false }
  }

  private animate(encoder: UREncoder): void {
    this.stopAnimation()
    this.qrParts = encoder.fragmentsLength
    this.qrData = encoder.nextPart().toUpperCase()
    const revision = this.revision
    this.animation = setInterval(() => {
      if (!this.isCurrent(revision)) { this.stopAnimation(); return }
      this.qrData = encoder.nextPart().toUpperCase()
    }, 200)
  }

  private stopAnimation(): void {
    if (this.animation) clearInterval(this.animation)
    this.animation = undefined
    this.qrData = ''
    this.qrParts = 0
  }

  private clear(): void {
    this.revision++
    if (this.cameraStart) clearTimeout(this.cameraStart)
    this.cameraStart = undefined
    this.stopScan()
    this.stopAnimation()
    this.decoder = undefined
    this.requestPsbt = undefined
    this.review = undefined
    this.cosigner = undefined
    this.hasScannedRequest = false
    this.progress = 0
    this.addedSignatures = 0
    this.alreadySignedInputs = 0
    this.busy = false
    this.errorKey = ''
    this.stage = 'setup'
  }

  private deactivate(): void { this.active = false; this.clear() }
}
