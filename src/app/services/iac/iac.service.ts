import {
  AppConfig,
  APP_CONFIG,
  BaseIACService,
  ClipboardService,
  DeeplinkService,
  IACMessageTransport,
  IACMessageWrapper,
  ProtocolService,
  RelayMessage,
  UiEventElementsService,
  UiEventService
} from '@airgap/angular-core'
import { AirGapWallet, AirGapWalletStatus, MainProtocolSymbols, UnsignedTransaction } from '@airgap/coinlib-core'
import { Inject, Injectable } from '@angular/core'

import { SignTransactionInfo } from '../../models/sign-transaction-info'
import { ErrorCategory, handleErrorLocal } from '../error-handler/error-handler.service'
import { InteractionOperationType, InteractionService } from '../interaction/interaction.service'
import { NavigationService } from '../navigation/navigation.service'
import { SecretsService } from '../secrets/secrets.service'
import { WalletAccessService } from '../wallet-access/wallet-access.service'
import { isMultisigPsbt } from '../bitcoin-multisig/bitcoin-multisig.service'
import * as bitcoinJS from '@airgap/coinlib-core/dependencies/src/bitcoinjs-lib-6.1.7/src/index'
import { ModalController, Platform } from '@ionic/angular'
import { SelectAccountPage } from 'src/app/pages/select-account/select-account.page'
import { RawTypedEthereumTransaction } from '@airgap/ethereum/v0/types/transaction-ethereum'
import { IACMessageType, IACMessageDefinitionObjectV3, MessageSignRequest } from '@airgap/serializer'
import { BitcoinSegwitTransactionSignRequest } from '@airgap/bitcoin'

@Injectable({
  providedIn: 'root'
})
export class IACService extends BaseIACService {
  constructor(
    public readonly uiEventService: UiEventService,
    public readonly uiEventElementsService: UiEventElementsService,
    public readonly deeplinkService: DeeplinkService,
    _protocolService: ProtocolService,
    protected readonly clipboard: ClipboardService,
    private readonly navigationService: NavigationService,
    private readonly secretsService: SecretsService,
    private readonly interactionService: InteractionService,
    private readonly modalController: ModalController,
    @Inject(APP_CONFIG) appConfig: AppConfig,
    protected readonly platform: Platform,
    private readonly access: WalletAccessService
  ) {
    super(uiEventElementsService, clipboard, secretsService.isReady(), [], deeplinkService, appConfig, platform)

    this.serializerMessageHandlers[IACMessageType.TransactionSignRequest] = this.handleUnsignedTransactions.bind(this)
    this.serializerMessageHandlers[IACMessageType.MessageSignRequest] = this.handleMessageSignRequest.bind(this)
  }

  public async relay(data: RelayMessage): Promise<void> {
    const contextId = this.access.getContextId()
    await this.interactionService.startInteraction({
      contextId,
      operationType: InteractionOperationType.WALLET_SYNC,
      iacMessage: (data as any).messages ?? (data as any).rawString // TODO: Fix types
    })
  }

  private async handleUnsignedTransactions(
    messageWrapper: IACMessageWrapper<IACMessageDefinitionObjectV3[]>,
    _transport: IACMessageTransport,
    scanAgainCallback: Function
  ): Promise<boolean> {
    const contextId = await this.requireOpenWallet()
    if (contextId === undefined) return false
    const signTransactionRequests: IACMessageDefinitionObjectV3[] = messageWrapper.result

    const multisigRequests = signTransactionRequests.filter((request) =>
      [MainProtocolSymbols.BTC, MainProtocolSymbols.BTC_SEGWIT].includes(request.protocol as MainProtocolSymbols) &&
      isMultisigPsbt((request.payload as UnsignedTransaction)?.transaction?.psbt)
    )
    if (multisigRequests.length > 0) {
      this.access.assertContext(contextId)
      if (signTransactionRequests.length !== 1) {
        await this.uiEventService.showTranslatedAlert({
          header: 'bitcoin-multisig.title', message: 'bitcoin-multisig.single-request', buttons: [{ text: 'OK' }]
        })
        return false
      }
      await this.navigationService.routeWithState('/bitcoin-multisig', {
        contextId,
        psbtHex: (multisigRequests[0].payload as UnsignedTransaction).transaction.psbt
      })
      return true
    }

    const transactionInfos: SignTransactionInfo[] = (
      await Promise.all(
        signTransactionRequests.map(async (signTransactionRequest): Promise<SignTransactionInfo> => {
          return this.findMatchingWallet(signTransactionRequest, messageWrapper.context)
        })
      )
    ).filter((signTransactionDetails) => signTransactionDetails.wallet !== undefined)

    this.access.assertContext(contextId)
    if (transactionInfos.length > 0 && transactionInfos.length === signTransactionRequests.length) {

      this.navigationService
        .routeWithState('deserialized-detail', {
          contextId,
          transactionInfos: transactionInfos,
          iacContext: messageWrapper.context,
          type: IACMessageType.TransactionSignRequest
        })

        .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))

      return true
    } else {
      const cancelButton = {
        text: 'tab-wallets.no-secret_alert.okay_label',
        role: 'cancel',
        handler: () => {
          scanAgainCallback()
        }
      }
      this.uiEventService.showTranslatedAlert({
        header: 'tab-wallets.no-secret_alert.title',
        message: 'tab-wallets.no-secret_alert.text',
        buttons: [cancelButton]
      })

      return false
    }
  }

  private async handleMessageSignRequest(
    messageWrapper: IACMessageWrapper<IACMessageDefinitionObjectV3[]>,
    _transport: IACMessageTransport,
    _scanAgainCallback: Function
  ): Promise<boolean> {
    const contextId = await this.requireOpenWallet()
    if (contextId === undefined) return false
    const messageDefinitionObjects: IACMessageDefinitionObjectV3[] = messageWrapper.result

    // A single approval covers one reviewed message. Do not accept hidden batches.
    if (!Array.isArray(messageDefinitionObjects) || messageDefinitionObjects.length !== 1) {
      await this.uiEventService.showTranslatedAlert({
        header: 'Sign one message at a time',
        message: 'Scan and review each message separately before signing.',
        buttons: [{ text: 'OK' }]
      })
      return false
    }

    const transactionInfos: SignTransactionInfo[] = await Promise.all(
      messageDefinitionObjects.map(async (messageDefinitionObject): Promise<SignTransactionInfo> => {
        return this.findMatchingSignWallet(messageDefinitionObject, messageWrapper.context)
      })
    )
    this.access.assertContext(contextId)
    this.navigationService
      .routeWithState('deserialized-detail', {
        contextId,
        transactionInfos: transactionInfos,
        iacContext: messageWrapper.context,
        type: IACMessageType.MessageSignRequest
      })
      .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))

    return true
  }

  private async requireOpenWallet(): Promise<number | undefined> {
    if (!this.access.isUnlocked()) {
      await this.uiEventService.showTranslatedAlert({
        header: 'Open a Secret first',
        message: 'Select a Secret and enter its wallet password before scanning a signing request.',
        buttons: [{ text: 'OK' }]
      })
      return undefined
    }
    return this.access.getContextId()
  }

  private async selectCurrentWallet(protocol: MainProtocolSymbols, type: string): Promise<AirGapWallet | undefined> {
    const contextId = this.access.getContextId()
    const modal = await this.modalController.create({ component: SelectAccountPage, componentProps: { type, symbolFilter: protocol } })
    this.access.assertContext(contextId)
    const dismissed = modal.onDidDismiss()
    await modal.present()
    const result = await dismissed
    this.access.assertContext(contextId)
    if (result.data !== undefined) this.access.assertWallet(result.data)
    return result.data
  }

  private assertChildPath(path: string | undefined, wallet: AirGapWallet): void {
    if (typeof path !== 'string') throw new Error('The signing request must specify its derivation path.')
    const normalized = path.startsWith('m/') ? path : `m/${path}`
    if (normalized !== wallet.derivationPath && !normalized.startsWith(wallet.derivationPath + '/')) {
      throw new Error('Derivation path of the request does not match the selected wallet.')
    }
  }

  private async activateWallet(wallet: AirGapWallet): Promise<void> {
    const contextId = this.access.getContextId()
    this.access.assertWallet(wallet)
    if (wallet.status === AirGapWalletStatus.ACTIVE) {
      return
    }

    wallet.status = AirGapWalletStatus.ACTIVE
    await this.secretsService.updateWallet(wallet)
    this.access.assertContext(contextId)
  }

  private async findMatchingWallet(
    signTransactionRequest: IACMessageDefinitionObjectV3,
    metadata: {
      requestId?: string
      derivationPath?: string
      sourceFingerprint?: string
    }
  ) {
    metadata = metadata ?? {}
    const contextId = this.access.getContextId()
    const unsignedTransaction: UnsignedTransaction = signTransactionRequest.payload as UnsignedTransaction

    // Select wallet by public key and protocol identifier
    let correctWallet = await this.secretsService.findWalletByPublicKeyAndProtocolIdentifier(
      unsignedTransaction.publicKey,
      signTransactionRequest.protocol
    )

    // If no wallet is found with public key and protocol identifier, it's probably because there is no public key.
    // This can happen if we work with third party wallets that have a different format that doesn't include the public key.

    // BTC: First we try to find a wallet by matching the masterFingerprint
    if (
      !correctWallet &&
      (signTransactionRequest.protocol === MainProtocolSymbols.BTC_SEGWIT ||
        signTransactionRequest.protocol === MainProtocolSymbols.BTC ||
        signTransactionRequest.protocol === MainProtocolSymbols.BTC_TAPROOT)
    ) {
      const transaction: BitcoinSegwitTransactionSignRequest['transaction'] = unsignedTransaction.transaction
      const decodedPSBT = bitcoinJS.Psbt.fromHex(transaction.psbt)
      const isTaproot = decodedPSBT.data.inputs.some((input) => input.tapBip32Derivation)

      for (const input of decodedPSBT.data.inputs) {
        const path = isTaproot ? input.tapBip32Derivation : input.bip32Derivation

        for (const derivation of path ?? []) {
          const masterFingerprint = derivation.masterFingerprint.toString('hex')

          correctWallet = await this.secretsService.findWalletByFingerprintDerivationPathAndProtocolIdentifier(
            masterFingerprint,
            signTransactionRequest.protocol,
            derivation.path,
            derivation.pubkey
          )
          if (correctWallet) {
            break
          }
        }
        if (correctWallet) {
          break
        }
      }

      // BTC: If we couldn't find a wallet using the masterFingerprint, it's possible that the masterFingerprint is invalid or a placeholder.
      // This can happen if the watch-only wallet doesn't have that information available. In this case, we need to show an account selection modal.
      if (!correctWallet && !unsignedTransaction.publicKey) {
        correctWallet = await this.selectCurrentWallet(signTransactionRequest.protocol as MainProtocolSymbols, 'psbt')
      }

      if (correctWallet && !unsignedTransaction.publicKey) {
        unsignedTransaction.publicKey = correctWallet.publicKey // PSBT txs don't include a public key, so we need to set it
      }
    }

    // ETH: MetaMask requests don't contain the public key information, we need to do the matching based on the sourceFingerprint
    if (
      !correctWallet &&
      (signTransactionRequest.protocol === MainProtocolSymbols.ETH ||
        signTransactionRequest.protocol === MainProtocolSymbols.OPTIMISM ||
        signTransactionRequest.protocol === MainProtocolSymbols.BNB ||
        signTransactionRequest.protocol === MainProtocolSymbols.BASE)
    ) {
      const transaction: RawTypedEthereumTransaction = unsignedTransaction.transaction

      const fingerprint = transaction.masterFingerprint ?? metadata.sourceFingerprint
      const derivationPath = transaction.derivationPath ?? metadata.derivationPath

      correctWallet = await this.findMetaMaskWallet(fingerprint, signTransactionRequest.protocol, derivationPath)

      if (correctWallet) this.assertChildPath(derivationPath, correctWallet)

      if (correctWallet && !unsignedTransaction.publicKey) {
        unsignedTransaction.publicKey = correctWallet.publicKey // MetaMask txs don't include a public key, so we need to set it
      }
    }

    if (correctWallet) {
      await this.activateWallet(correctWallet)
    }

    if (!correctWallet) {
      correctWallet = await this.findBaseWallet(unsignedTransaction.publicKey, signTransactionRequest)
    }

    this.access.assertContext(contextId)
    if (correctWallet) this.access.assertWallet(correctWallet)
    const secret = correctWallet ? this.secretsService.findByPublicKey(correctWallet.publicKey) : undefined

    return {
      wallet: correctWallet,
      secret,
      signTransactionRequest
    }
  }

  private async findMatchingSignWallet(
    messageDefinitionObject: IACMessageDefinitionObjectV3,
    metadata: {
      requestId?: string
      derivationPath?: string
      sourceFingerprint?: string
    }
  ) {
    metadata = metadata ?? {}
    const contextId = this.access.getContextId()
    const messageSignRequest: MessageSignRequest = messageDefinitionObject.payload as MessageSignRequest

    let correctWallet = await this.secretsService.findWalletByPublicKeyAndProtocolIdentifier(
      messageSignRequest.publicKey,
      messageDefinitionObject.protocol
    )

    // ETH: MetaMask requests don't contain the public key information, we need to do the matching based on the sourceFingerprint
    if (!correctWallet && !messageSignRequest.publicKey && messageDefinitionObject.protocol === MainProtocolSymbols.ETH) {
      correctWallet = await this.findMetaMaskWallet(metadata.sourceFingerprint, messageDefinitionObject.protocol, metadata.derivationPath)

      if (correctWallet) this.assertChildPath(metadata.derivationPath, correctWallet)
    }

    if (correctWallet) {
      await this.activateWallet(correctWallet)
    }

    if (!correctWallet) {
      correctWallet = await this.findBaseWallet(messageSignRequest.publicKey, messageDefinitionObject)
    }

    if (!correctWallet && !messageSignRequest.publicKey) {
      correctWallet = await this.selectCurrentWallet(messageDefinitionObject.protocol as MainProtocolSymbols, 'message-account')
    }
    this.access.assertContext(contextId)
    if (!correctWallet) throw new Error('No account from the currently opened wallet matches this signing request.')
    this.access.assertWallet(correctWallet)
    if (metadata.derivationPath) this.assertChildPath(metadata.derivationPath, correctWallet)
    const secret = this.secretsService.findByPublicKey(correctWallet.publicKey)

    return {
      wallet: correctWallet,
      secret,
      signTransactionRequest: {
        ...messageDefinitionObject,
        payload: {
          ...messageSignRequest,
          publicKey: correctWallet.publicKey // Bind an empty-key request to the explicitly selected current account.
        }
      }
    }
  }

  private async findBaseWallet(
    publicKey: string,
    messageDefinitionObject: IACMessageDefinitionObjectV3
  ): Promise<AirGapWallet | undefined> {
    // If we can't find a wallet for a protocol, we will try to find the "base" wallet and then create a new
    // wallet with the right protocol. This way we can sign all ERC20 transactions, but show the right amount
    // and fee for all tokens we support.
    let correctWallet: AirGapWallet | undefined

    const baseWallet: AirGapWallet | undefined = await this.secretsService.findBaseWalletByPublicKeyAndProtocolIdentifier(
      publicKey,
      messageDefinitionObject.protocol
    )

    if (baseWallet) {
      await this.activateWallet(baseWallet)
      // Keep the registered account object. A synthetic protocol wallet would
      // bypass the current-profile ownership identity. The IAC request retains
      // its original protocol identifier for transaction details and responses.
      correctWallet = baseWallet
    }

    return correctWallet
  }

  private async findMetaMaskWallet(
    fingerprint: string,
    protocol: MainProtocolSymbols,
    derivationPath: string
  ): Promise<AirGapWallet | undefined> {
    if (!fingerprint || !derivationPath) return undefined
    let correctWallet: AirGapWallet | undefined
    correctWallet = await this.secretsService.findWalletByXPubFingerprintDerivationPathAndProtocolIdentifier(
      fingerprint,
      protocol,
      derivationPath
    )

    return correctWallet
  }
}
