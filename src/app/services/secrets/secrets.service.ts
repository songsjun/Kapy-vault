import { ProtocolService } from '@airgap/angular-core'
import {
  AirGapWallet,
  AirGapWalletStatus,
  ICoinProtocol,
  MainProtocolSymbols,
  ProtocolSymbols
} from '@airgap/coinlib-core'
import { Injectable } from '@angular/core'
import { AlertController, LoadingController } from '@ionic/angular'
import { BIP32Factory } from '@airgap/coinlib-core/dependencies/src/bip32-5.0.1/src/index'
import * as ecc from '@airgap/coinlib-core/dependencies/src/@bitcoinerlab/secp256k1-1.2.0/src/index'
import { Observable, ReplaySubject } from 'rxjs'

import { MnemonicSecret } from '../../models/secret'
import { ErrorCategory, handleErrorLocal } from '../error-handler/error-handler.service'
import { NavigationService } from '../navigation/navigation.service'
import { SecureStorageService } from '../secure-storage/secure-storage.service'
import { VaultStorageKey, VaultStorageService } from '../storage/storage.service'

import bs58check from '@airgap/coinlib-core/dependencies/src/bs58check-4.0.0/src/index'
import { TranslateService } from '@ngx-translate/core'
import { WalletAccessService } from '../wallet-access/wallet-access.service'

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

interface AddWalletConifg {
  protocolIdentifier: ProtocolSymbols
  isHDWallet: boolean
  customDerivationPath: string
  bip39Passphrase?: string
  isActive: boolean
}
@Injectable({
  providedIn: 'root'
})
export class SecretsService {
  private readonly ready: Promise<void>
  private readonly secretsList: MnemonicSecret[] = []
  private activeSecret: MnemonicSecret
  private readonly legacySecrets = new Map<string, MnemonicSecret>()
  private bip32 = BIP32Factory(ecc)

  private readonly activeSecret$: ReplaySubject<MnemonicSecret> = new ReplaySubject(1)
  private readonly secrets$: ReplaySubject<MnemonicSecret[]> = new ReplaySubject(1)

  constructor(
    _secureStorageService: SecureStorageService,
    private readonly storageService: VaultStorageService,
    _protocolService: ProtocolService,
    _navigationService: NavigationService,
    private readonly loadingCtrl: LoadingController,
    _translateService: TranslateService,
    private readonly alertCtrl: AlertController,
    private readonly walletAccess: WalletAccessService
  ) {
    this.walletAccess.setMetadataWriter(() => this.persist())
    this.walletAccess.changes$.subscribe(() => {
      this.activeSecret = this.walletAccess.getCurrentSecret()
      this.activeSecret$.next(this.activeSecret)
    })
    this.ready = this.init()
  }

  private async init(): Promise<void> {
    const secrets: MnemonicSecret[] = await this.read()
    this.secretsList.push(...secrets.map((obj: MnemonicSecret) => MnemonicSecret.init(obj)))
    this.secrets$.next(this.secretsList)
    this.activeSecret = undefined
    this.activeSecret$.next(undefined)
  }

  public isReady(): Promise<void> {
    return this.ready
  }

  private async read(): Promise<MnemonicSecret[]> {
    const rawSecretsPayload: unknown = await this.storageService.get(VaultStorageKey.AIRGAP_SECRET_LIST)

    // necessary due to double serialization bug we had
    let secrets: MnemonicSecret[] = typeof rawSecretsPayload === 'string' ? JSON.parse(rawSecretsPayload) : rawSecretsPayload

    if (!secrets) {
      secrets = []
    }

    for (const secret of secrets) {
      // Do not derive, decrypt or restore public accounts while listing Secrets.
      // Preserve legacy records verbatim until explicitly re-imported by the user.
      if (!this.walletAccess.isConfigured(secret)) {
        this.legacySecrets.set(secret.id, JSON.parse(JSON.stringify(secret)))
      }
      secret.wallets = []
    }

    return secrets
  }

  public async createSecret(secret: MnemonicSecret, defaultPassword: string): Promise<void> {
    const initialOperation = this.walletAccess.getOperationId()
    await this.isReady()
    this.walletAccess.assertOperationId(initialOperation)
    if (!secret.secretHex || this.secretsList.some((existing) => existing.id === secret.id || existing.fingerprint === secret.fingerprint)) {
      throw new Error('Already added secret')
    }
    this.walletAccess.lock()
    const epoch = this.walletAccess.getOperationId()
    const entropy = secret.secretHex
    let committed = false
    try {
      await this.walletAccess.setup(secret, defaultPassword)
      this.walletAccess.assertOperationId(epoch)
      secret.flushSecret()
      await this.persist([...this.secretsList, secret])
      committed = true
      this.secretsList.push(secret)
      this.secrets$.next(this.secretsList)
      this.walletAccess.assertOperationId(epoch)
      await this.walletAccess.unlock(secret, defaultPassword)
    } catch (error) {
      if (!committed) {
        secret.secretHex = entropy
        delete secret.walletAccessVersion
      }
      throw error
    }
  }

  public async addOrUpdateSecret(secret: MnemonicSecret, options: { setActive: boolean } = { setActive: true }): Promise<void> {
    this.walletAccess.requireDefault(secret)
    const epoch = this.walletAccess.getContextId()
    const index = this.secretsList.findIndex((item) => item.id === secret.id)
    if (index < 0 || secret.secretHex) { throw new Error('Create a new Secret with a default wallet password first') }
    this.secretsList[index] = secret
    if (options.setActive) { this.setActiveSecret(secret) }
    await this.persist()
    this.walletAccess.assertContext(epoch)
  }

  public async remove(secret: MnemonicSecret): Promise<void> {
    this.walletAccess.requireDefault(secret)
    await this.walletAccess.destroy(secret)

    this.secretsList.splice(this.secretsList.indexOf(secret), 1)
    this.secrets$.next(this.secretsList)

    if (this.activeSecret === secret) {
      this.setActiveSecret(this.secretsList[0])
    }

    await this.persist()
  }

  public async resetRecoveryPassword(secret: MnemonicSecret): Promise<string> {
    return this.walletAccess.createRecoveryKey(secret)
  }

  public async retrieveEntropyForSecret(secret: MnemonicSecret): Promise<string> {
    return this.walletAccess.readEntropy(secret)
  }

  public findByFingerprint(fingerprint: string): MnemonicSecret | undefined {
    return this.getWallets().some((wallet) => wallet.masterFingerprint === fingerprint) ? this.walletAccess.getCurrentSecret() : undefined
  }

  public findByPublicKey(pubKey: string): MnemonicSecret | undefined {
    return this.getWallets().some((wallet) => wallet.publicKey === pubKey) ? this.walletAccess.getCurrentSecret() : undefined
  }

  public getWallets(): AirGapWallet[] {
    return this.walletAccess.getWallets().filter((wallet) => wallet.status !== AirGapWalletStatus.DELETED)
  }

  public async getWalletsByProtocolIdentifier(protocolIdentifier: ProtocolSymbols, secret?: MnemonicSecret): Promise<AirGapWallet[]> {
    const wallets = this.walletAccess.getWallets(secret)
    const filtered = await Promise.all(
      wallets.map(async (wallet) => {
        const identifier = await wallet.protocol.getIdentifier()
        return identifier === protocolIdentifier && wallet.status === AirGapWalletStatus.ACTIVE ? wallet : undefined
      })
    )
    return filtered.filter((w): w is AirGapWallet => w !== undefined)
  }

  private isBtcProtocol(protocolIdentifier: ProtocolSymbols): boolean {
    return (
      protocolIdentifier === MainProtocolSymbols.BTC ||
      protocolIdentifier === MainProtocolSymbols.BTC_SEGWIT ||
      protocolIdentifier === MainProtocolSymbols.BTC_TAPROOT
    )
  }

  public async getNextDerivationPathForProtocol(
    protocol: ICoinProtocol,
    secret: MnemonicSecret
  ): Promise<{ derivationPath: string; isHDWallet: boolean }> {
    this.walletAccess.requireUnlocked(secret)
    const protocolIdentifier = await protocol.getIdentifier()
    const existingWallets = await this.getWalletsByProtocolIdentifier(protocolIdentifier, secret)
    const standardPath = await protocol.getStandardDerivationPath()
    const isBtc = this.isBtcProtocol(protocolIdentifier)
    const supportsHD = await protocol.getSupportsHD()

    if (existingWallets.length === 0) {
      // First wallet - use standard path
      // For BTC and HD-capable protocols, use HD wallet
      // For non-HD protocols, use non-HD wallet
      return { derivationPath: standardPath, isHDWallet: isBtc || supportsHD }
    }

    if (isBtc) {
      // BTC protocols: Always HD, increment account index
      const lastIndices = existingWallets.map((wallet) => {
        const match = wallet.derivationPath.match(/(\d+)[h']?\/?$/)
        return match ? parseInt(match[1], 10) : 0
      })
      const maxIndex = Math.max(...lastIndices)
      const nextIndex = maxIndex + 1
      const newPath = standardPath.replace(/(\d+)([h']?)(\/?)?$/, `${nextIndex}$2$3`)
      return { derivationPath: newPath, isHDWallet: true }
    } else if (supportsHD) {
      // HD-capable protocols (ETH, OP, etc.): First is HD, subsequent are non-HD

      const addressIndices = existingWallets.map((wallet) => {
        if (wallet.isExtendedPublicKey) {
          // HD wallet is equivalent to /0/0
          return 0
        }
        // Non-HD wallet - extract last number from path
        const match = wallet.derivationPath.match(/\/(\d+)$/)
        return match ? parseInt(match[1], 10) : 0
      })
      const maxIndex = Math.max(...addressIndices)
      const nextIndex = maxIndex + 1
      return { derivationPath: `${standardPath}/0/${nextIndex}`, isHDWallet: false }
    } else {
      // Non-HD protocols: Increment last number in path
      // e.g., m/44h/1729h/0h/0h -> m/44h/1729h/0h/1h
      const lastIndices = existingWallets.map((wallet) => {
        const match = wallet.derivationPath.match(/(\d+)[h']?\/?$/)
        return match ? parseInt(match[1], 10) : 0
      })
      const maxIndex = Math.max(...lastIndices)
      const nextIndex = maxIndex + 1
      const newPath = standardPath.replace(/(\d+)([h']?)(\/?)?$/, `${nextIndex}$2$3`)
      return { derivationPath: newPath, isHDWallet: false }
    }
  }

  public async removeWallets(wallets: AirGapWallet[]): Promise<void[]> {
    const results: void[] = []
    for (const wallet of wallets) {
      results.push(await this.removeWallet(wallet))
    }
    return results
  }

  public async removeWallet(wallet: AirGapWallet): Promise<void> {
    return this.walletAccess.deleteAccount(wallet)
  }

  public async findWalletByPublicKeyAndProtocolIdentifier(
    pubKey: string,
    protocolIdentifier: ProtocolSymbols
  ): Promise<AirGapWallet | undefined> {
    const secret: MnemonicSecret | undefined = this.findByPublicKey(pubKey)
    if (!secret) {
      return undefined
    }

    const filtered: (AirGapWallet | undefined)[] = await Promise.all(
      secret.wallets.map(async (wallet: AirGapWallet) => {
        return wallet.publicKey === pubKey && (await wallet.protocol.getIdentifier()) === protocolIdentifier ? wallet : undefined
      })
    )

    return filtered.find((wallet: AirGapWallet | undefined) => wallet !== undefined)
  }

  public async findWalletByFingerprintDerivationPathAndProtocolIdentifier(
    fingerprint: string,
    protocolIdentifier: ProtocolSymbols,
    derivationPath: string,
    publicKey: Buffer
  ): Promise<AirGapWallet | undefined> {
    const secret: MnemonicSecret | undefined = this.findByFingerprint(fingerprint)
    if (!secret) {
      return undefined
    }

    const filtered: (AirGapWallet | undefined)[] = await Promise.all(
      secret.wallets.map(async (wallet: AirGapWallet) => {
        const match = wallet.masterFingerprint === fingerprint && (await wallet.protocol.getIdentifier()) === protocolIdentifier
        if (match) {
          if (!derivationPath.startsWith(wallet.derivationPath)) {
            return undefined
          }

          // This uses the same logic to find child key as "sign" method in the BitcoinSegwitProtocol
          const bip32PK = this.bip32.fromBase58(new ExtendedPublicKey(wallet.publicKey).toXpub())
          const cutoffFrom = derivationPath.lastIndexOf("'") || derivationPath.lastIndexOf('h')
          const childPath = derivationPath.substr(cutoffFrom + 2)
          const walletPublicKey = bip32PK.derivePath(childPath).publicKey

          if (protocolIdentifier === MainProtocolSymbols.BTC_TAPROOT) {
            // For Taproot, we need to compare the public key as a hex string
            return publicKey.toString('hex') === Buffer.from(walletPublicKey.slice(1)).toString('hex') ? wallet : undefined
          }

          return publicKey.toString('hex') === Buffer.from(walletPublicKey).toString('hex') ? wallet : undefined
        }

        return undefined
      })
    )

    return filtered.find((wallet: AirGapWallet | undefined) => wallet !== undefined)
  }

  /**
   * Find a wallet based on the source fingerprint of the xPub
   *
   * @param sourceFingerprint The fingerprint of the xPub
   * @param protocolIdentifier
   * @param derivationPath
   * @returns
   */
  public async findWalletByXPubFingerprintDerivationPathAndProtocolIdentifier(
    sourceFingerprint: string,
    protocolIdentifier: ProtocolSymbols,
    derivationPath: string
  ): Promise<AirGapWallet | undefined> {
    const filtered: (AirGapWallet | undefined)[] = await Promise.all(
      this.getWallets().map(async (wallet: AirGapWallet) => {
          const match =
            wallet.isExtendedPublicKey && // Only extended public keys are relevant
            (await wallet.protocol.getIdentifier()) === protocolIdentifier &&
            `m/${derivationPath}`.startsWith(wallet.derivationPath)

          return match ? wallet : undefined
        })
    )
    const allWallets: AirGapWallet[] = filtered.filter((wallet: AirGapWallet | undefined) => wallet !== undefined)

    const foundWallet: AirGapWallet | undefined = allWallets.find((wallet: AirGapWallet) => {
      const bip32PK = this.bip32.fromBase58(new ExtendedPublicKey(wallet.publicKey).toXpub())

      return Buffer.from(bip32PK.fingerprint).toString('hex') === sourceFingerprint
    })

    return foundWallet
  }

  public async findBaseWalletByPublicKeyAndProtocolIdentifier(
    pubKey: string,
    protocolIdentifier: ProtocolSymbols
  ): Promise<AirGapWallet | undefined> {
    const secret: MnemonicSecret | undefined = this.findByPublicKey(pubKey)
    if (!secret) {
      return undefined
    }

    const filtered: (AirGapWallet | undefined)[] = await Promise.all(
      secret.wallets.map(async (wallet: AirGapWallet) => {
        return wallet.publicKey === pubKey && protocolIdentifier.startsWith(await wallet.protocol.getIdentifier()) ? wallet : undefined
      })
    )

    return filtered.find((wallet: AirGapWallet | undefined) => wallet !== undefined)
  }

  public getActiveSecret(): MnemonicSecret {
    return this.walletAccess.getCurrentSecret()
  }

  public setActiveSecret(secret: MnemonicSecret): void {
    if (this.walletAccess.getCurrentSecret() && !this.walletAccess.isUnlocked(secret)) {
      this.walletAccess.lock()
    }
    this.activeSecret = secret
    this.activeSecret$.next(secret)
  }

  public getActiveSecretObservable(): Observable<MnemonicSecret> {
    return this.activeSecret$.asObservable()
  }

  public getSecretsObservable(): Observable<MnemonicSecret[]> {
    return this.secrets$.asObservable()
  }

  private async persist(source: MnemonicSecret[] = this.secretsList): Promise<void> {
    const secrets = source.map((secret) => {
      secret.flushSecret()
      if (!this.walletAccess.isConfigured(secret)) {
        return this.legacySecrets.get(secret.id) ?? secret
      }
      // Explicit public DTO: never serialize runtime wallets, verifiers or passwords.
      return {
        id: secret.id,
        label: secret.label,
        type: secret.type,
        isParanoia: secret.isParanoia,
        hasSocialRecovery: secret.hasSocialRecovery,
        hasRecoveryKey: secret.hasRecoveryKey,
        fingerprint: secret.fingerprint,
        createdAtTimestamp: secret.createdAtTimestamp,
        walletAccessVersion: secret.walletAccessVersion,
        wallets: []
      }
    })
    await this.storageService.set(VaultStorageKey.AIRGAP_SECRET_LIST, secrets)
    this.secrets$.next(this.secretsList)
  }

  public async updateWallet(wallet: AirGapWallet): Promise<void> {
    await this.walletAccess.updateAccount(wallet)
  }

  public async addWallets(secret: MnemonicSecret, configs: AddWalletConifg[]): Promise<AirGapWallet[]> {
    this.walletAccess.requireUnlocked(secret)
    const loading = await this.loadingCtrl.create({ message: 'Deriving your wallet...' })
    await loading.present()
    try {
      return await this.walletAccess.addAccounts(secret, configs.filter((config) => config.isActive).map((config) => ({
        protocolIdentifier: config.protocolIdentifier,
        isHDWallet: config.isHDWallet,
        customDerivationPath: config.customDerivationPath
      })))
    } finally {
      await loading.dismiss()
    }
  }

  public async getKnownViewingKeys(): Promise<string[]> {
    const filtered: (string | undefined)[] = await Promise.all(
      this.getWallets().map(async (wallet: AirGapWallet) => {
        return (await wallet.protocol.getIdentifier()) === MainProtocolSymbols.XTZ_SHIELDED ? wallet.publicKey : undefined
      })
    )

    return filtered.filter((publicKey: string | undefined) => publicKey !== undefined)
  }

  public async showAlert(title: string, message: string): Promise<void> {
    const alert: HTMLIonAlertElement = await this.alertCtrl.create({
      header: title,
      message,
      backdropDismiss: false,
      buttons: [
        {
          text: 'Okay!',
          role: 'cancel'
        }
      ]
    })
    alert.present().catch(handleErrorLocal(ErrorCategory.IONIC_ALERT))
  }

}
