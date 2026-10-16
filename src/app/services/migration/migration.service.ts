import { AirGapWallet, AirGapWalletStatus } from '@airgap/coinlib-core'
import { Injectable } from '@angular/core'
import { BIP32Factory } from '@airgap/coinlib-core/dependencies/src/bip32-5.0.1/src/index'
import * as ecc from '@airgap/coinlib-core/dependencies/src/@bitcoinerlab/secp256k1-1.2.0/src/index'
import { entropyToMnemonic, mnemonicToSeed } from 'bip39'

import { MnemonicSecret } from '../../models/secret'
import { isSecretMigrated, isWalletMigrated } from '../../utils/migration'
import { ErrorCategory, handleErrorLocal } from '../error-handler/error-handler.service'
import { NavigationService } from '../navigation/navigation.service'
import { SecretsService } from '../secrets/secrets.service'
import { WalletAccessService } from '../wallet-access/wallet-access.service'

@Injectable({
  providedIn: 'root'
})
export class MigrationService {
  private readonly bip32 = BIP32Factory(ecc)
  constructor(private readonly secretsService: SecretsService, private readonly navigationService: NavigationService,
      private readonly access: WalletAccessService) {}

  public async runSecretsMigration(secrets: MnemonicSecret[]): Promise<void> {
    const contextId = this.access.getContextId()
    for (const secret of secrets) this.access.requireDefault(secret)
    if (!secrets.every(isSecretMigrated)) {
      await this.navigateToMigrationPage({ secrets, contextId }, contextId)
      this.access.assertContext(contextId)
    }
  }

  public async runWalletsMigration(wallets: AirGapWallet[]): Promise<void> {
    const contextId = this.access.getContextId()
    for (const wallet of wallets) this.access.assertWallet(wallet)
    if (!wallets.every(isWalletMigrated)) {
      await this.navigateToMigrationPage({ wallets, contextId }, contextId)
      this.access.assertContext(contextId)
    }
  }

  private async navigateToMigrationPage(navigationData: any, contextId: number): Promise<void> {
    this.access.assertContext(contextId)
    return new Promise((resolve, reject) => {
      this.navigationService.routeWithState('/migration', {
        ...navigationData,
        onSuccess: () => {
          try { this.access.assertContext(contextId); resolve() } catch (error) { reject(error) }
        },
        onError: reject
      }).catch((error) => {
        handleErrorLocal(ErrorCategory.IONIC_NAVIGATION)(error)
        reject(error)
      })
    })
  }

  public filterMigratedSecrets(secrets: MnemonicSecret[]): [MnemonicSecret[], boolean] {
    // the migration is a one-time event, after it's run on every secret, they will stabilize on this condition
    if (secrets.every(isSecretMigrated)) {
      return [secrets, true]
    }

    return [secrets.filter(isSecretMigrated), false]
  }

  public filterMigratedWallets(wallets: AirGapWallet[]): [AirGapWallet[], boolean] {
    // the migration is a one-time event, after it's run on every wallet, they will stabilize on this condition
    if (wallets.every(isWalletMigrated)) {
      return [wallets, true]
    }

    return [wallets.filter(isWalletMigrated), false]
  }

  public async deepFilterMigratedSecretsAndWallets(secrets: MnemonicSecret[]): Promise<[MnemonicSecret[], boolean]> {
    // the migration is a one-time event, after it's run on every secret, they will stabilize on this condition
    if (secrets.every(isSecretMigrated)) {
      return [secrets, true]
    }

    const migratedSecrets: (MnemonicSecret | undefined)[] = await Promise.all(
      secrets.map(async (secret: MnemonicSecret) => {
        if (!secret.fingerprint) {
          return undefined
        }

        const [migratedWallets]: [AirGapWallet[], boolean] = this.filterMigratedWallets(secret.wallets)
        if (migratedWallets.length === 0) {
          return undefined
        }

        const newSecret: MnemonicSecret = MnemonicSecret.init(secret)
        newSecret.wallets = migratedWallets

        return newSecret
      })
    )

    // create a new array of migrated secrets with filtered wallets
    return [migratedSecrets.filter((secret: MnemonicSecret | undefined) => secret !== undefined), false]
  }

  public async migrateSecret(secret: MnemonicSecret, options: { persist?: boolean } = {}): Promise<void> {
    const contextId = this.access.getContextId()
    this.access.requireDefault(secret)
    if (!this.access.isConfigured(secret)) throw new Error('Re-import this legacy Secret with a default wallet password first.')
    if (!secret.fingerprint) {
      const entropy = await this.secretsService.retrieveEntropyForSecret(secret)
      this.access.assertContext(contextId)
      this.access.requireDefault(secret)
      const seed = await mnemonicToSeed(entropyToMnemonic(entropy))
      try {
        this.access.assertContext(contextId)
        this.access.requireDefault(secret)
        secret.fingerprint = Buffer.from(this.bip32.fromSeed(new Uint8Array(seed)).fingerprint).toString('hex')
      } finally { seed.fill(0) }
    }
    if (options.persist) {
      await this.secretsService.addOrUpdateSecret(secret, { setActive: false })
      this.access.assertContext(contextId)
    }
  }

  public async migrateWallet(wallet: AirGapWallet, options: { persist?: boolean } = {}): Promise<void> {
    const contextId = this.access.getContextId()
    this.access.assertWallet(wallet)
    const secret = this.access.getCurrentSecret()
    if (!this.access.isConfigured(secret)) throw new Error('Re-import this legacy Secret with a default wallet password first.')
    if (wallet.masterFingerprint && !options.persist) return

    const passphrase = this.access.getPassphrase(secret)
    const entropy = await this.secretsService.retrieveEntropyForSecret(secret)
    this.access.assertContext(contextId)
    this.access.assertWallet(wallet, secret)
    const mnemonic = entropyToMnemonic(entropy)
    const publicKey = wallet.isExtendedPublicKey
      ? await wallet.protocol.getExtendedPublicKeyFromMnemonic(mnemonic, wallet.derivationPath, passphrase)
      : await wallet.protocol.getPublicKeyFromMnemonic(mnemonic, wallet.derivationPath, passphrase)
    this.access.assertContext(contextId)
    this.access.assertWallet(wallet, secret)
    if (publicKey !== wallet.publicKey) throw new Error('This account does not belong to the currently opened wallet.')

    const seed = await mnemonicToSeed(mnemonic, passphrase)
    try {
      this.access.assertContext(contextId)
      this.access.assertWallet(wallet, secret)
      wallet.masterFingerprint = Buffer.from(this.bip32.fromSeed(new Uint8Array(seed)).fingerprint).toString('hex')
      wallet.status = AirGapWalletStatus.ACTIVE
    } finally { seed.fill(0) }
    if (options.persist) {
      await this.access.updateAccount(wallet)
      this.access.assertContext(contextId)
    }
  }
}
