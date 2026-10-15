import { Injectable } from '@angular/core'
import { ProtocolService } from '@airgap/angular-core'
import { AirGapWallet, AirGapWalletStatus, ProtocolSymbols } from '@airgap/coinlib-core'
import { BIP32Factory } from '@airgap/coinlib-core/dependencies/src/bip32-5.0.1/src/index'
import * as ecc from '@airgap/coinlib-core/dependencies/src/@bitcoinerlab/secp256k1-1.2.0/src/index'
import { randomBytes } from '@airgap/coinlib-core/dependencies/src/@noble/hashes-1.8.0/src/utils'
import { entropyToMnemonic, mnemonicToSeed } from 'bip39'
import { BehaviorSubject, Observable } from 'rxjs'
import { MnemonicSecret } from '../../models/secret'
import { SecureStorageService } from '../secure-storage/secure-storage.service'
import {
  WalletSecretEnvelope, createEnvelope, openEnvelope, addKeySlot, removeKeySlot,
  replaceKeySlot, encryptPayload, decryptPayload, parseEnvelope
} from './wallet-secret-crypto'

export interface WalletAccountConfig {
  id: string
  protocolIdentifier: ProtocolSymbols
  networkIdentifier?: string
  isHDWallet: boolean
  customDerivationPath: string
  status: AirGapWalletStatus
  addressIndex?: number
}

interface WalletPassphrase {
  id: string
  isDefault: boolean
  accounts: WalletAccountConfig[]
}

interface WalletAccessRegistry {
  version: 2
  secretId: string
  entries: WalletPassphrase[]
}

interface StoredWalletSecret {
  format: 'airgap-wallet-data-v2'
  secretId: string
  entropy: string
  registry: WalletAccessRegistry
}

// No password, entropy, seed or verifier is published to observers or navigation.
export interface WalletAccessContext {
  secretId: string
  profileId: string
  isDefault: boolean
  epoch: number
  wallets: AirGapWallet[]
}

@Injectable({ providedIn: 'root' })
export class WalletAccessService {
  private epoch: number = 0
  private mutationTail: Promise<void> = Promise.resolve()
  private metadataWriter: () => Promise<void> = async () => undefined
  private current?: {
    secret: MnemonicSecret
    registry: WalletAccessRegistry
    context: WalletAccessContext
    passphrase: string
    key: Uint8Array
    envelope: WalletSecretEnvelope
  }
  private readonly subject = new BehaviorSubject<WalletAccessContext | undefined>(undefined)
  public readonly changes$: Observable<WalletAccessContext | undefined> = this.subject.asObservable()
  private readonly walletIds = new WeakMap<AirGapWallet, string>()
  private readonly bip32 = BIP32Factory(ecc)

  constructor(private readonly secureStorage: SecureStorageService, private readonly protocols: ProtocolService) {}

  public setMetadataWriter(writer: () => Promise<void>): void { this.metadataWriter = writer }

  public isConfigured(secret: MnemonicSecret): boolean {
    return secret?.walletAccessVersion === 2
  }

  public getStorageLocation(secret: MnemonicSecret): { alias: string; key: string; isParanoia: false } {
    // iOS item accounts are not namespaced by the native key alias.
    const key = 'wallet-v2-' + secret.id
    return { alias: key, key, isParanoia: false }
  }

  public async setup(secret: MnemonicSecret, defaultPassword: string): Promise<void> {
    const epoch = this.epoch
    this.validatePassword(defaultPassword)
    if (this.isConfigured(secret)) {
      throw new Error('Wallet password is already configured')
    }
    const registry: WalletAccessRegistry = {
      version: 2,
      secretId: secret.id,
      entries: [{ id: this.newId(), isDefault: true, accounts: [] }]
    }
    await this.writeRegistry(secret, registry, defaultPassword, epoch)
    this.assertOperation(epoch)
    secret.isParanoia = false
    secret.walletAccessVersion = 2
  }

  public async unlock(secret: MnemonicSecret, password: string): Promise<void> {
    this.lock()
    const epoch = this.epoch
    this.validatePassword(password)
    if (!this.isConfigured(secret)) {
      throw new Error('This Secret needs to be re-imported with a default wallet password')
    }
    // A native write already in flight cannot be cancelled by an epoch change.
    // Drain it before reading, so a new session cannot cache and later restore
    // an older key-slot list over the completed write.
    await this.mutationTail
    this.assertOperation(epoch)
    const envelope = await this.readEnvelope(secret)
    this.assertOperation(epoch)
    const opened = await openEnvelope(envelope, password)
    let retained = false
    try {
      this.assertOperation(epoch)
      const stored = this.parseStoredSecret(opened.plaintext, secret, envelope)
      const registry = stored.registry
      const entry = registry.entries.find((candidate) => candidate.id === opened.profileId)
      if (!entry) { throw new Error('Invalid wallet password registry') }
      const passphrase = entry.isDefault ? '' : password
      const wallets: AirGapWallet[] = []
      for (const config of entry.accounts) {
        wallets.push(await this.deriveWallet(stored.entropy, passphrase, config))
        this.assertOperation(epoch)
      }
      const context: WalletAccessContext = { secretId: secret.id, profileId: entry.id, isDefault: entry.isDefault, epoch, wallets }
      this.current = { secret, registry, context, passphrase, key: opened.key, envelope }
      retained = true
      secret.wallets = wallets
      this.subject.next(context)
    } finally {
      if (!retained) { opened.key.fill(0) }
    }
  }

  public lock(): void {
    this.epoch++
    if (this.current) {
      this.current.secret.wallets = []
      this.current.context.wallets.length = 0
      this.current.passphrase = ''
      this.current.key.fill(0)
    }
    this.current = undefined
    this.subject.next(undefined)
  }

  public getOperationId(): number { return this.epoch }

  public assertOperationId(epoch: number): void { this.assertOperation(epoch) }

  public isUnlocked(secret?: MnemonicSecret): boolean {
    return this.current !== undefined && (!secret || secret.id === this.current.context.secretId)
  }

  public isDefaultUnlocked(secret?: MnemonicSecret): boolean {
    return this.isUnlocked(secret) && this.current.context.isDefault
  }

  public requireUnlocked(secret?: MnemonicSecret): WalletAccessContext {
    if (!this.isUnlocked(secret)) {
      throw new Error('Open the Secret and enter its wallet password first')
    }
    return this.current.context
  }

  public requireDefault(secret?: MnemonicSecret): void {
    if (!this.isDefaultUnlocked(secret)) {
      throw new Error('The default wallet password is required to manage this Secret')
    }
  }

  public getCurrentSecret(): MnemonicSecret | undefined {
    return this.current?.secret
  }

  public getWallets(secret?: MnemonicSecret): AirGapWallet[] {
    return this.isUnlocked(secret) ? this.current.context.wallets.slice() : []
  }

  public getPassphrase(secret?: MnemonicSecret): string {
    this.requireUnlocked(secret)
    return this.current.passphrase
  }

  public getContextId(): number {
    return this.requireUnlocked().epoch
  }

  public assertContext(epoch: number): void {
    if (!this.current || this.current.context.epoch !== epoch || this.epoch !== epoch) {
      throw new Error('Wallet access has changed. Open the wallet again')
    }
  }

  public assertWallet(wallet: AirGapWallet, secret?: MnemonicSecret): void {
    if (!this.requireUnlocked(secret).wallets.includes(wallet) || wallet.status === AirGapWalletStatus.DELETED) {
      throw new Error('This account does not belong to the open wallet')
    }
  }

  public getShareGroupId(secret?: MnemonicSecret): string {
    const context = this.requireUnlocked(secret)
    return context.profileId
  }

  public async listPassphrases(secret: MnemonicSecret): Promise<{ id: string; isDefault: boolean }[]> {
    this.requireDefault(secret)
    return this.current.registry.entries.map(({ id, isDefault }) => ({ id, isDefault }))
  }

  public async registerPassphrase(secret: MnemonicSecret, password: string): Promise<void> {
    const epoch = this.getContextId()
    return this.mutate(epoch, () => this.registerPassphraseImpl(secret, password))
  }

  private async registerPassphraseImpl(secret: MnemonicSecret, password: string): Promise<void> {
    this.requireDefault(secret)
    const epoch = this.getContextId()
    this.validatePassword(password)
    const registry = this.cloneRegistry()
    if (registry.entries.length >= 32) {
      throw new Error('A Secret can contain at most 32 wallet passwords')
    }
    const id = this.newId()
    const envelope = await addKeySlot(this.current.envelope, this.current.key, id, password)
    this.assertContext(epoch)
    registry.entries.push({ id, isDefault: false, accounts: [] })
    await this.commitRegistry(secret, registry, epoch, envelope)
  }

  public async removePassphrase(secret: MnemonicSecret, id: string): Promise<void> {
    const epoch = this.getContextId()
    return this.mutate(epoch, () => this.removePassphraseImpl(secret, id))
  }

  private async removePassphraseImpl(secret: MnemonicSecret, id: string): Promise<void> {
    this.requireDefault(secret)
    const epoch = this.getContextId()
    const registry = this.cloneRegistry()
    const entry = registry.entries.find((candidate) => candidate.id === id)
    if (!entry || entry.isDefault) {
      throw new Error('The default wallet password cannot be removed')
    }
    registry.entries = registry.entries.filter((candidate) => candidate.id !== id)
    const envelope = removeKeySlot(this.current.envelope, id)
    await this.commitRegistry(secret, registry, epoch, envelope)
  }

  public async changeDefaultPassword(secret: MnemonicSecret, password: string): Promise<void> {
    const epoch = this.getContextId()
    return this.mutate(epoch, () => this.changeDefaultPasswordImpl(secret, password))
  }

  private async changeDefaultPasswordImpl(secret: MnemonicSecret, password: string): Promise<void> {
    this.requireDefault(secret)
    const epoch = this.getContextId()
    this.validatePassword(password)
    const registry = this.cloneRegistry()
    const entry = registry.entries.find((candidate) => candidate.isDefault)
    const envelope = await replaceKeySlot(this.current.envelope, this.current.key, entry.id, password)
    this.assertContext(epoch)
    await this.commitRegistry(secret, registry, epoch, envelope)
  }

  public async addAccounts(secret: MnemonicSecret, configs: Omit<WalletAccountConfig, 'id' | 'status'>[]): Promise<AirGapWallet[]> {
    const epoch = this.getContextId()
    return this.mutate(epoch, () => this.addAccountsImpl(secret, configs))
  }

  private async addAccountsImpl(secret: MnemonicSecret, configs: Omit<WalletAccountConfig, 'id' | 'status'>[]): Promise<AirGapWallet[]> {
    const context = this.requireUnlocked(secret)
    const epoch = context.epoch
    const registry = this.cloneRegistry()
    const entry = registry.entries.find((candidate) => candidate.id === context.profileId)
    const entropy = await this.readEntropy(secret)
    this.assertContext(epoch)
    const wallets: AirGapWallet[] = []
    for (const config of configs) {
      this.validateConfig(config)
      const protocol = await this.protocols.getProtocol(config.protocolIdentifier, config.networkIdentifier)
      const networkIdentifier = (await protocol.getOptions()).network.identifier
      const duplicate = entry.accounts.find((account) => account.protocolIdentifier === config.protocolIdentifier &&
        account.networkIdentifier === networkIdentifier && account.customDerivationPath === config.customDerivationPath &&
        account.isHDWallet === config.isHDWallet)
      if (duplicate && duplicate.status !== AirGapWalletStatus.DELETED) {
        continue
      }
      const account: WalletAccountConfig = { ...config, id: duplicate?.id ?? this.newId(), networkIdentifier, status: AirGapWalletStatus.ACTIVE }
      this.assertContext(epoch)
      const wallet = await this.deriveWallet(entropy, this.current.passphrase, account)
      this.assertContext(epoch)
      if (duplicate) {
        Object.assign(duplicate, account)
      } else {
        entry.accounts.push(account)
      }
      wallets.push(wallet)
    }
    await this.commitRegistry(secret, registry, epoch)
    for (const wallet of wallets) {
      const id = this.walletIds.get(wallet)
      const oldIndex = context.wallets.findIndex((old) => this.walletIds.get(old) === id)
      if (oldIndex >= 0) {
        context.wallets.splice(oldIndex, 1, wallet)
      } else {
        context.wallets.push(wallet)
      }
    }
    this.subject.next(context)
    return wallets
  }

  public async updateAccount(wallet: AirGapWallet): Promise<void> {
    const epoch = this.getContextId()
    return this.mutate(epoch, () => this.updateAccountImpl(wallet))
  }

  private async updateAccountImpl(wallet: AirGapWallet): Promise<void> {
    this.assertWallet(wallet)
    const epoch = this.getContextId()
    const registry = this.cloneRegistry()
    const entry = registry.entries.find((candidate) => candidate.id === this.current.context.profileId)
    const account = entry.accounts.find((candidate) => candidate.id === this.walletIds.get(wallet))
    if (!account) {
      throw new Error('Account configuration was not found')
    }
    account.status = wallet.status
    account.addressIndex = wallet.addressIndex
    await this.commitRegistry(this.current.secret, registry, epoch)
  }

  public async deleteAccount(wallet: AirGapWallet): Promise<void> {
    const epoch = this.getContextId()
    return this.mutate(epoch, () => this.deleteAccountImpl(wallet))
  }

  private async deleteAccountImpl(wallet: AirGapWallet): Promise<void> {
    this.assertWallet(wallet)
    const previous = wallet.status
    try {
      wallet.status = AirGapWalletStatus.DELETED
      // updateAccount deliberately accepts a deletion only from this trusted path.
      const epoch = this.getContextId()
      const registry = this.cloneRegistry()
      const entry = registry.entries.find((candidate) => candidate.id === this.current.context.profileId)
      const account = entry.accounts.find((candidate) => candidate.id === this.walletIds.get(wallet))
      if (!account) { throw new Error('Account configuration was not found') }
      account.status = AirGapWalletStatus.DELETED
      await this.commitRegistry(this.current.secret, registry, epoch)
      this.subject.next(this.current.context)
    } catch (error) {
      wallet.status = previous
      throw error
    }
  }

  public async destroy(secret: MnemonicSecret): Promise<void> {
    const epoch = this.getContextId()
    return this.mutate(epoch, () => this.destroyImpl(secret))
  }

  private async destroyImpl(secret: MnemonicSecret): Promise<void> {
    this.requireDefault(secret)
    const epoch = this.getContextId()
    const location = this.getStorageLocation(secret)
    const store = await this.secureStorage.get(location.alias, location.isParanoia)
    this.assertContext(epoch)
    await store.removeItem(location.key)
    this.assertContext(epoch)
    this.lock()
  }

  private mutate<T>(epoch: number, operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(() => {
      this.assertContext(epoch)
      return operation()
    })
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async deriveWallet(entropy: string, passphrase: string, config: WalletAccountConfig): Promise<AirGapWallet> {
    const protocol = await this.protocols.getProtocol(config.protocolIdentifier, config.networkIdentifier)
    const mnemonic = entropyToMnemonic(entropy)
    const seed = await mnemonicToSeed(mnemonic, passphrase)
    const fingerprint = Buffer.from(this.bip32.fromSeed(new Uint8Array(seed)).fingerprint).toString('hex')
    // Preserve AirGap's per-protocol mnemonic/password derivation, including Substrate.
    const publicKey = config.isHDWallet
      ? await protocol.getExtendedPublicKeyFromMnemonic(mnemonic, config.customDerivationPath, passphrase)
      : await protocol.getPublicKeyFromMnemonic(mnemonic, config.customDerivationPath, passphrase)
    const wallet = new AirGapWallet(protocol, publicKey, config.isHDWallet, config.customDerivationPath, fingerprint, config.status)
    wallet.addresses = await wallet.deriveAddresses(1)
    wallet.addressIndex = config.addressIndex ?? 0
    this.walletIds.set(wallet, config.id)
    seed.fill(0)
    return wallet
  }

  private validatePassword(password: string): void {
    if (typeof password !== 'string' || password.length === 0 || Buffer.byteLength(password, 'utf8') > 1024) {
      throw new Error('Enter a non-empty wallet password of at most 1024 UTF-8 bytes')
    }
  }

  private validateConfig(config: Omit<WalletAccountConfig, 'id' | 'status'>): void {
    if (typeof config.protocolIdentifier !== 'string' || !config.protocolIdentifier || typeof config.isHDWallet !== 'boolean' ||
      typeof config.customDerivationPath !== 'string' || !/^m(?:\/[0-9]+['h]?)*$/.test(config.customDerivationPath) ||
      (config.networkIdentifier !== undefined && typeof config.networkIdentifier !== 'string')) {
      throw new Error('Invalid account configuration')
    }
  }

  private newId(): string { return Buffer.from(randomBytes(16)).toString('hex') }
  private cloneRegistry(): WalletAccessRegistry { return JSON.parse(JSON.stringify(this.current.registry)) }
  private assertOperation(epoch: number): void {
    if (epoch !== this.epoch) { throw new Error('Wallet opening was cancelled') }
  }

  public async readEntropy(secret: MnemonicSecret): Promise<string> {
    const epoch = this.requireUnlocked(secret).epoch
    // Keep the native authentication boundary for signing and root-secret
    // exports. v2 uses system authentication, without a second wallet password.
    const envelope = await this.readEnvelope(secret)
    this.assertContext(epoch)
    const plaintext = await decryptPayload(envelope, this.current.key)
    this.assertContext(epoch)
    return this.parseStoredSecret(plaintext, secret, envelope).entropy
  }

  public async recoveryPayload(secret: MnemonicSecret): Promise<string> {
    this.requireDefault(secret)
    // Recovery never exports a plaintext Secret or a data-encryption key.
    return JSON.stringify(this.current.envelope)
  }

  public async createRecoveryKey(secret: MnemonicSecret): Promise<string> {
    const epoch = this.getContextId()
    return this.mutate(epoch, async () => {
      this.requireDefault(secret)
      const location = this.getStorageLocation(secret)
      const store = await this.secureStorage.get(location.alias, location.isParanoia)
      this.assertContext(epoch)
      const payload = await this.recoveryPayload(secret)
      this.assertContext(epoch)
      const result = await store.setupRecoveryPassword(location.key, payload)
      this.assertContext(epoch)
      secret.hasRecoveryKey = true
      try {
        await this.metadataWriter()
        this.assertContext(epoch)
      } catch (error) {
        secret.hasRecoveryKey = false
        throw error
      }
      return result.recoveryKey
    })
  }

  private async writeRegistry(secret: MnemonicSecret, registry: WalletAccessRegistry, password: string, epoch: number): Promise<void> {
    if (!/^(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{48}|[a-f0-9]{56}|[a-f0-9]{64})$/i.test(secret.secretHex)) {
      throw new Error('Invalid Secret entropy')
    }
    const stored: StoredWalletSecret = { format: 'airgap-wallet-data-v2', secretId: secret.id, entropy: secret.secretHex, registry }
    const sealed = await createEnvelope(secret.id, registry.entries[0].id, password, JSON.stringify(stored))
    try {
      this.assertOperation(epoch)
      const location = this.getStorageLocation(secret)
      const store = await this.secureStorage.get(location.alias, location.isParanoia)
      this.assertOperation(epoch)
      // One native item keeps the encrypted Secret and all password key slots
      // together, including Android's single-item recovery snapshot.
      await store.setItem(location.key, JSON.stringify(sealed.envelope))
      this.assertOperation(epoch)
    } finally {
      sealed.key.fill(0)
    }
  }

  private async commitRegistry(secret: MnemonicSecret, registry: WalletAccessRegistry, epoch: number,
      nextEnvelope?: WalletSecretEnvelope): Promise<void> {
    this.assertContext(epoch)
    const stored = await this.readOpenSecret(secret)
    this.assertContext(epoch)
    stored.registry = registry
    const envelope = await encryptPayload(nextEnvelope ?? this.current.envelope, this.current.key, JSON.stringify(stored))
    this.assertContext(epoch)
    this.parseStoredSecret(JSON.stringify(stored), secret, envelope)
    const location = this.getStorageLocation(secret)
    const store = await this.secureStorage.get(location.alias, location.isParanoia)
    this.assertContext(epoch)
    await store.setItem(location.key, JSON.stringify(envelope))
    this.assertContext(epoch)
    this.current.registry = registry
    this.current.envelope = envelope
    if (secret.hasRecoveryKey) {
      secret.hasRecoveryKey = false
      await this.metadataWriter()
      this.assertContext(epoch)
    }
  }

  private async readEnvelope(secret: MnemonicSecret): Promise<WalletSecretEnvelope> {
    const location = this.getStorageLocation(secret)
    const store = await this.secureStorage.get(location.alias, location.isParanoia)
    return parseEnvelope((await store.getItem(location.key)).value, secret.id)
  }

  private async readOpenSecret(secret: MnemonicSecret): Promise<StoredWalletSecret> {
    const epoch = this.requireUnlocked(secret).epoch
    const { envelope, key } = this.current
    const plaintext = await decryptPayload(envelope, key)
    this.assertContext(epoch)
    return this.parseStoredSecret(plaintext, secret, envelope)
  }

  private parseStoredSecret(value: string, secret: MnemonicSecret, envelope: WalletSecretEnvelope): StoredWalletSecret {
    let stored: StoredWalletSecret
    try {
      stored = JSON.parse(value)
    } catch (_) {
      throw new Error('Invalid stored Secret. Restore from your mnemonic and passphrases')
    }
    if (stored?.format !== 'airgap-wallet-data-v2' || stored.secretId !== secret.id ||
      typeof stored.entropy !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{48}|[a-f0-9]{56}|[a-f0-9]{64})$/i.test(stored.entropy)) {
      throw new Error('Invalid stored Secret. Restore from your mnemonic and passphrases')
    }
    const registry = stored.registry
    if (registry?.version !== 2 || registry.secretId !== secret.id || !Array.isArray(registry.entries) ||
      registry.entries.length !== envelope.slots.length || registry.entries.length < 1 || registry.entries.length > 32 ||
      registry.entries.filter((entry) => entry.isDefault === true).length !== 1 ||
      new Set(registry.entries.map((entry) => entry.id)).size !== registry.entries.length) {
      throw new Error('Invalid wallet password registry')
    }
    for (const entry of registry.entries) {
      if (!/^[a-f0-9]{32}$/.test(entry.id) || typeof entry.isDefault !== 'boolean' || !Array.isArray(entry.accounts) ||
        !envelope.slots.some((slot) => slot.id === entry.id)) {
        throw new Error('Invalid wallet password registry')
      }
      for (const config of entry.accounts) {
        this.validateConfig(config)
        if (!/^[a-f0-9]{32}$/.test(config.id) || !Object.values(AirGapWalletStatus).includes(config.status) ||
          (config.addressIndex !== undefined && (!Number.isSafeInteger(config.addressIndex) || config.addressIndex < 0))) {
          throw new Error('Invalid stored account configuration')
        }
      }
    }
    return stored
  }
}
