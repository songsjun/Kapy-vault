import {
  assertNever,
  flattenAirGapTxAddresses,
  IACContext,
  ICoinProtocolAdapter,
  KeyPairService,
  ProtocolService,
  sumAirGapTxValues,
  TransactionService
} from '@airgap/angular-core'
import {
  AirGapWallet,
  IAirGapTransaction,
  ICoinProtocol,
  MainProtocolSymbols,
  ProtocolSymbols,
  SignedTransaction,
  UnsignedTransaction
} from '@airgap/coinlib-core'
import { IACMessageType, IACMessageDefinitionObjectV3, MessageSignRequest } from '@airgap/serializer'
import { TezosCryptoClient, TezosSaplingProtocol } from '@airgap/tezos'
import { Injectable } from '@angular/core'
import { Actions, createEffect, ofType } from '@ngrx/effects'
import { Action, Store } from '@ngrx/store'
import { TranslateService } from '@ngx-translate/core'
import * as bip39 from 'bip39'
import { concat, from, of } from 'rxjs'
import { catchError, first, switchMap, tap, withLatestFrom } from 'rxjs/operators'

import { SignTransactionInfo } from '../../models/sign-transaction-info'
import { InteractionOperationType, InteractionService } from '../../services/interaction/interaction.service'
import { NavigationService } from '../../services/navigation/navigation.service'
import { SecretsService } from '../../services/secrets/secrets.service'
import { WalletAccessService } from '../../services/wallet-access/wallet-access.service'
import { PsbtInputValidationError, validatePsbtTransactionInputs } from '../../services/bitcoin/psbt-input-validation'

import * as actions from './deserialized-detail.actions'
import * as fromDeserializedDetail from './deserialized-detail.reducer'
import {
  DeserializedSignedMessage,
  DeserializedSignedTransaction,
  DeserializedUnsignedMessage,
  DeserializedUnsignedTransaction,
  Mode,
  Payload,
  Task
} from './deserialized.detail.types'

@Injectable()
export class DeserializedDetailEffects {
  private pageContextId: number | undefined
  public viewClosed$ = createEffect(() => this.actions$.pipe(
    ofType(actions.viewClosed), tap(() => { this.pageContextId = undefined })
  ), { dispatch: false })
  public navigationData$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.viewInitialization),
      switchMap(() => concat(of(actions.navigationDataLoading()), from(this.loadNavigationData()).pipe(first())))
    )
  )

  public approved$ = createEffect(() => this.actions$.pipe(
    ofType(actions.approved),
    withLatestFrom(this.store.select(fromDeserializedDetail.selectFinalPayload)),
    switchMap(([_, payload]) => {
      try {
        this.assertRequestContext(this.pageContextId)
        if (!payload) throw new Error('No signing request is loaded.')
        return of(actions.runningBlockingTask({ task: this.identifyPayloadTask(payload), userInput: { contextId: this.pageContextId } }))
      } catch {
        return of(actions.unknownError({ message: 'Open a Secret and scan the request again.' }))
      }
    })
  ))

  public continueApproved$ = createEffect(() => this.actions$.pipe(
    ofType(actions.continueApproved),
    withLatestFrom(this.store.select(fromDeserializedDetail.selectFinalPayload)),
    switchMap(([action, payload]) => from(this.handlePayload(payload, action.userInput)).pipe(
      first(), catchError(() => of(actions.operationCancelled()))
    ))
  ))

  public navigateWithSignedTransactions$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(actions.transactionsSigned),
        tap((action) => { this.navigateWithSignedTransactions(action.transactions, action.contextId).catch(() => undefined) })
      ),
    { dispatch: false }
  )

  public navigateWithSignedMessages$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(actions.messagesSigned),
        tap((action) => { this.navigateWithSignedMessages(action.messages, action.contextId).catch(() => undefined) })
      ),
    { dispatch: false }
  )

  constructor(
    private readonly actions$: Actions,
    private readonly store: Store<fromDeserializedDetail.State>,
    private readonly navigationService: NavigationService,
    private readonly translateService: TranslateService,
    private readonly protocolService: ProtocolService,
    private readonly secretsService: SecretsService,
    private readonly keyPairService: KeyPairService,
    private readonly transactionService: TransactionService,
    private readonly interactionService: InteractionService,
    private readonly access: WalletAccessService
  ) {}

  private async loadNavigationData(): Promise<Action> {
    const state = this.navigationService.getState()
    try {
      this.access.assertContext(state.contextId)
      this.pageContextId = state.contextId
      for (const info of state.transactionInfos ?? []) this.access.assertWallet(info.wallet, info.secret)
    } catch {
      this.pageContextId = undefined
      return actions.unknownError({ message: 'Open a Secret and scan the request again.' })
    }
    const [, messageType]: [string | undefined, string | undefined] = this.getPageTypes(state.type)
    const mode: Mode | undefined = this.getMode(state.type)

    if (messageType !== undefined && mode !== undefined && state.transactionInfos !== undefined) {
      const title: string = this.translateService.instant(`deserialized-detail.${messageType}.title`)
      const button: string = this.translateService.instant(`deserialized-detail.${messageType}.button_label`)
      const raw: string = this.signTransactionInfoToRaw(state.transactionInfos)
      try {
        const [transactions, messages]: [DeserializedUnsignedTransaction[], DeserializedUnsignedMessage[]] = await Promise.all([
          this.signTransactionInfoToUnsignedTransactions(state.transactionInfos, state.iacContext),
          this.signTransactionInfoToUnsignedMessages(state.transactionInfos, state.iacContext)
        ])

        this.assertRequestContext(state.contextId)
        return actions.navigationDataLoaded({ mode, title, button, transactions, messages, raw })
      } catch (error) {
        try { this.assertRequestContext(state.contextId) } catch { return actions.operationCancelled() }
        if (error instanceof PsbtInputValidationError) {
          this.pageContextId = undefined
          return actions.invalidTransactionInputs({ message: error.message })
        }
        return actions.navigationDataLoadingError({ mode, title, button, raw })
      }
    } else {
      return actions.invalidData()
    }
  }

  private getPageTypes(iacMessageType: IACMessageType | undefined): [string | undefined, string | undefined] {
    let actionType: string | undefined
    if (iacMessageType === IACMessageType.TransactionSignRequest || iacMessageType === IACMessageType.MessageSignRequest) {
      actionType = 'request'
    } else if (iacMessageType === IACMessageType.TransactionSignResponse || iacMessageType === IACMessageType.MessageSignResponse) {
      actionType = 'response'
    }

    let messageType: string | undefined
    if (iacMessageType === IACMessageType.TransactionSignRequest || iacMessageType === IACMessageType.TransactionSignResponse) {
      messageType = 'transaction'
    } else if (iacMessageType === IACMessageType.MessageSignRequest || iacMessageType === IACMessageType.MessageSignResponse) {
      messageType = 'message'
    }

    return [actionType, messageType]
  }

  private getMode(iacMessageType: IACMessageType | undefined): Mode | undefined {
    switch (iacMessageType) {
      case IACMessageType.TransactionSignRequest:
        return Mode.SIGN_TRANSACTION
      case IACMessageType.MessageSignRequest:
        return Mode.SIGN_MESSAGE
      default:
        return undefined
    }
  }

  private signTransactionInfoToRaw(transactionInfo: SignTransactionInfo[]): string {
    const transactions: unknown[] = transactionInfo.map((info: SignTransactionInfo): unknown => {
      switch (info.signTransactionRequest.type) {
        case IACMessageType.TransactionSignRequest:
          return (info.signTransactionRequest.payload as UnsignedTransaction).transaction
        case IACMessageType.TransactionSignResponse:
          return (info.signTransactionRequest.payload as SignedTransaction).transaction
        default:
          return info.signTransactionRequest.payload
      }
    })
    const toStringify: unknown | unknown[] = transactions.length > 1 ? transactions : transactions[0]

    return JSON.stringify(toStringify)
  }

  private async signTransactionInfoToUnsignedTransactions(
    transactionInfo: SignTransactionInfo[],
    iacContext?: IACContext
  ): Promise<DeserializedUnsignedTransaction[]> {
    return Promise.all(
      transactionInfo
        .map((info: SignTransactionInfo): [AirGapWallet, IACMessageDefinitionObjectV3] => [info.wallet, info.signTransactionRequest])
        .filter(
          ([_, request]: [AirGapWallet, IACMessageDefinitionObjectV3]): boolean => request.type === IACMessageType.TransactionSignRequest
        )
        .map(async ([wallet, request]: [AirGapWallet, IACMessageDefinitionObjectV3]): Promise<DeserializedUnsignedTransaction> => {
          await this.validateTransactionInputs(wallet, request.payload as UnsignedTransaction)
          let details: IAirGapTransaction[]
          if (await this.checkIfSaplingTransaction(request.payload as UnsignedTransaction, request.protocol)) {
            details = await this.transactionService.getDetailsFromIACMessages([request], {
              overrideProtocol: await this.getSaplingProtocol(),
              data: {
                knownViewingKeys: await this.secretsService.getKnownViewingKeys(),
                transactionOwner: request.protocol
              }
            })
          } else {
            details = await this.transactionService.getDetailsFromIACMessages([request])
          }

          return {
            type: 'unsigned',
            id: request.id,
            details,
            data: request.payload as UnsignedTransaction,
            iacContext,
            wallet,
            originalProtocolIdentifier: request.protocol !== (await wallet.protocol.getSymbol()) ? request.protocol : undefined
          }
        })
    )
  }

  private async signTransactionInfoToUnsignedMessages(
    transactionInfo: SignTransactionInfo[],
    iacContext?: IACContext
  ): Promise<DeserializedUnsignedMessage[]> {
    return Promise.all(
      transactionInfo
        .map((info: SignTransactionInfo): [AirGapWallet, IACMessageDefinitionObjectV3] => [info.wallet, info.signTransactionRequest])
        .filter(([_, request]: [AirGapWallet, IACMessageDefinitionObjectV3]): boolean => request.type === IACMessageType.MessageSignRequest)
        .map(async ([wallet, request]: [AirGapWallet, IACMessageDefinitionObjectV3]): Promise<DeserializedUnsignedMessage> => {
          const data: MessageSignRequest = request.payload as MessageSignRequest

          let blake2bHash: string | undefined
          if (request.protocol === MainProtocolSymbols.XTZ) {
            const cryptoClient = new TezosCryptoClient()
            blake2bHash = await cryptoClient.blake2bLedgerHash(data.message)
          }

          return {
            type: 'unsigned',
            id: request.id,
            protocol: request.protocol,
            data,
            iacContext,
            blake2bHash,
            wallet,
            originalProtocolIdentifier: request.protocol !== (await wallet.protocol.getSymbol()) ? request.protocol : undefined
          }
        })
    )
  }

  private identifyPayloadTask(payload: Payload): Task {
    switch (payload.mode) {
      case Mode.SIGN_TRANSACTION:
        return 'signTransaction'
      case Mode.SIGN_MESSAGE:
        return 'signMessage'
      default:
        return 'generic'
    }
  }

  private assertRequestContext(contextId: number): void {
    if (contextId === undefined || this.pageContextId !== contextId) throw new Error('The signing request is closed.')
    this.access.assertContext(contextId)
  }

  private async handlePayload(payload: Payload | undefined, userInput: actions.UserInput): Promise<Action> {
    this.assertRequestContext(userInput.contextId)
    if (!payload) throw new Error('No signing request is loaded.')
    switch (payload.mode) {
      case Mode.SIGN_TRANSACTION: return this.signTransactions(payload.data, userInput.contextId)
      case Mode.SIGN_MESSAGE: return this.signMessages(payload.data, userInput.contextId)
      default: return assertNever('handlePayload', payload)
    }
  }

  private async signTransactions(unsignedTransactions: DeserializedUnsignedTransaction[], contextId: number): Promise<Action> {
    try {
      this.assertRequestContext(contextId)
      // Reject an invalid batch before any member can read entropy or sign.
      for (const transaction of unsignedTransactions) {
        this.access.assertWallet(transaction.wallet)
        await this.validateTransactionInputs(transaction.wallet, transaction.data)
        this.assertRequestContext(contextId)
      }
      const transactions: DeserializedSignedTransaction[] = await Promise.all(unsignedTransactions.map(async (transaction) => {
        const signed = await this.signTransaction(transaction.wallet, transaction.data, transaction.iacContext, contextId)
        return {
          type: 'signed' as const, id: transaction.id, details: transaction.details,
          data: { accountIdentifier: transaction.wallet.publicKey, transaction: signed, callbackURL: transaction.data.callbackURL },
          iacContext: transaction.iacContext, wallet: transaction.wallet, originalProtocolIdentifier: transaction.originalProtocolIdentifier
        }
      }))
      this.assertRequestContext(contextId)
      return actions.transactionsSigned({ transactions, contextId })
    } catch (error) {
      try { this.assertRequestContext(contextId) } catch { return actions.operationCancelled() }
      if (error instanceof PsbtInputValidationError) {
        this.pageContextId = undefined
        return actions.invalidTransactionInputs({ message: error.message })
      }
      return actions.unknownError({ message: 'This signing request does not match the currently opened wallet.' })
    }
  }

  private async validateTransactionInputs(wallet: AirGapWallet, transaction: UnsignedTransaction): Promise<void> {
    const identifier = await wallet.protocol.getIdentifier()
    validatePsbtTransactionInputs(identifier, transaction)
  }

  private async signTransaction(wallet: AirGapWallet, transaction: UnsignedTransaction, iacContext: IACContext | undefined, contextId: number): Promise<string> {
    this.assertRequestContext(contextId)
    this.access.assertWallet(wallet)
    await this.validateTransactionInputs(wallet, transaction)
    this.assertRequestContext(contextId)
    const secret = this.access.getCurrentSecret()
    const entropy = await this.secretsService.retrieveEntropyForSecret(secret)
    this.assertRequestContext(contextId)
    this.access.assertWallet(wallet, secret)
    const childPath = await this.getChildDerivationPath(wallet.derivationPath, iacContext?.derivationPath)
    this.assertRequestContext(contextId)
    const result = await this.keyPairService.signWithProtocol(
      wallet.protocol, transaction, bip39.entropyToMnemonic(entropy), this.access.getPassphrase(secret),
      wallet.isExtendedPublicKey, wallet.derivationPath, childPath
    )
    this.assertRequestContext(contextId)
    return result
  }

  private async signMessages(unsignedMessages: DeserializedUnsignedMessage[], contextId: number): Promise<Action> {
    try {
      this.assertRequestContext(contextId)
      // Recheck here because navigation or persisted state can bypass the scan handler.
      if (!Array.isArray(unsignedMessages) || unsignedMessages.length !== 1) {
        return actions.unknownError({ message: 'Sign one message at a time. Scan and review each message separately.' })
      }
      const messages: DeserializedSignedMessage[] = await Promise.all(unsignedMessages.map(async (message) => {
        const signature = await this.signMessage(message.data, message.iacContext, message.wallet, contextId)
        return {
          type: 'signed' as const, id: message.id, protocol: message.protocol,
          data: { message: message.data.message, publicKey: message.wallet.publicKey, signature, callbackURL: message.data.callbackURL },
          iacContext: message.iacContext, wallet: message.wallet, originalProtocolIdentifier: message.originalProtocolIdentifier
        }
      }))
      this.assertRequestContext(contextId)
      return actions.messagesSigned({ messages, contextId })
    } catch {
      try { this.assertRequestContext(contextId) } catch { return actions.operationCancelled() }
      return actions.unknownError({ message: 'This message does not match an account in the currently opened wallet.' })
    }
  }

  private async signMessage(message: MessageSignRequest, iacContext: IACContext | undefined, wallet: AirGapWallet | undefined, contextId: number): Promise<string> {
    this.assertRequestContext(contextId)
    if (!wallet) throw new Error('Select an account from the currently opened wallet before signing a message.')
    this.access.assertWallet(wallet)
    if (message.publicKey && message.publicKey !== wallet.publicKey) throw new Error('The request belongs to another account.')
    const secret = this.access.getCurrentSecret()
    const entropy = await this.secretsService.retrieveEntropyForSecret(secret)
    this.assertRequestContext(contextId)
    const childPath = await this.getChildDerivationPath(wallet.derivationPath, iacContext?.derivationPath)
    this.assertRequestContext(contextId)
    // Bind empty-public-key messages to the explicitly selected current account.
    const result = await this.keyPairService.signWithProtocol(
      wallet.protocol, { ...message, publicKey: wallet.publicKey }, bip39.entropyToMnemonic(entropy),
      this.access.getPassphrase(secret), wallet.isExtendedPublicKey, wallet.derivationPath, childPath
    )
    this.assertRequestContext(contextId)
    return result
  }

  private async navigateWithSignedTransactions(transactions: DeserializedSignedTransaction[], contextId: number): Promise<void> {
    this.assertRequestContext(contextId)
    const messages: IACMessageDefinitionObjectV3[] = await this.generateTransactionIACMessages(transactions)
    this.assertRequestContext(contextId)
    await this.interactionService.startInteraction({
      contextId,
      operationType: InteractionOperationType.TRANSACTION_BROADCAST,
      iacMessage: messages,
      wallets: transactions.map((transaction: DeserializedSignedTransaction): AirGapWallet => transaction.wallet),
      signedTxs: transactions.map((transaction: DeserializedSignedTransaction): string => transaction.data.transaction)
    })
  }

  private async generateTransactionIACMessages(transactions: DeserializedSignedTransaction[]): Promise<IACMessageDefinitionObjectV3[]> {
    const signResponses: IACMessageDefinitionObjectV3[] = await Promise.all(
      transactions.map(
        async (transaction: DeserializedSignedTransaction): Promise<IACMessageDefinitionObjectV3> => ({
          id: transaction.id,
          protocol: transaction.originalProtocolIdentifier ?? (await transaction.wallet.protocol.getIdentifier()),
          type: IACMessageType.TransactionSignResponse,
          payload: {
            accountIdentifier: transaction.data.accountIdentifier,
            transaction: transaction.data.transaction,
            from: flattenAirGapTxAddresses(transaction.details, 'from'),
            to: flattenAirGapTxAddresses(transaction.details, 'to'),
            amount: sumAirGapTxValues(transaction.details, 'amount'),
            fee: sumAirGapTxValues(transaction.details, 'fee')
          } as any
          // Before splitting coinlib and introducing v1 protocols, payload was a union of all known messages, protocol specific transactions included.
          // The common interface defined for the transactions specifies only the `accountIdentifier` and `transaction` fields, the rest seen in the above structure
          // comes from the signed Bitcoin transaction. The changes introduced for v1 protocols simplified the type of `payload` by removing the protocol specific
          // messages from the union, basing the type only on the common interface. Because of that, the above no longer compiles unless forced to, therefore `as any`
          // had to be applied.
          // !!! This should be adressed and improved during the v0 -> v1 migration !!!
        })
      )
    )
    return signResponses
  }

  private async navigateWithSignedMessages(messages: DeserializedSignedMessage[], contextId: number): Promise<void> {
    this.assertRequestContext(contextId)
    const iacMessages: IACMessageDefinitionObjectV3[] = await this.generateIACMessages(messages)
    this.assertRequestContext(contextId)
    await this.interactionService.startInteraction({
      contextId,
      operationType: InteractionOperationType.MESSAGE_SIGN_REQUEST,
      iacMessage: iacMessages,
      messageSignResponse:
        messages[0] !== undefined
          ? {
              message: messages[0].data.message,
              publicKey: messages[0].data.publicKey,
              signature: messages[0].data.signature
            }
          : undefined
    })
  }

  private async generateIACMessages(messages: DeserializedSignedMessage[]): Promise<IACMessageDefinitionObjectV3[]> {
    const signResponses: IACMessageDefinitionObjectV3[] = messages.map(
      (message: DeserializedSignedMessage): IACMessageDefinitionObjectV3 => ({
        id: message.id,
        protocol: message.originalProtocolIdentifier ?? message.protocol,
        type: IACMessageType.MessageSignResponse,
        payload: {
          message: message.data.message,
          publicKey: message.data.publicKey,
          signature: message.data.signature
        }
      })
    )
    return signResponses
  }

  private async checkIfSaplingTransaction(transaction: UnsignedTransaction, protocolIdentifier: ProtocolSymbols): Promise<boolean> {
    if (protocolIdentifier === MainProtocolSymbols.XTZ) {
      try {
        const saplingAdapter: ICoinProtocolAdapter<TezosSaplingProtocol> = await this.getSaplingProtocol()
        const txDetails: IAirGapTransaction[] = await saplingAdapter.getTransactionDetails(transaction, {
          transactionOwner: protocolIdentifier
        })
        const recipients: string[] = txDetails
          .map((details) => details.to)
          .reduce((flatten: string[], next: string[]) => flatten.concat(next), [])

        // TODO: find better way to check if `transaction` is a Sapling transaction
        return recipients.some((recipient: string) => recipient.startsWith('zet') || recipient.toLocaleLowerCase() === 'shielded pool')
      } catch {
        return false
      }
    }

    return protocolIdentifier === MainProtocolSymbols.XTZ_SHIELDED
  }

  private async getSaplingProtocol(): Promise<ICoinProtocolAdapter<TezosSaplingProtocol>> {
    const protocol: ICoinProtocol = await this.protocolService.getProtocol(MainProtocolSymbols.XTZ_SHIELDED)
    if (!(protocol instanceof ICoinProtocolAdapter)) {
      throw new Error('Unexpected Sapling protocol implementation')
    }

    return protocol as ICoinProtocolAdapter<TezosSaplingProtocol>
  }

  private async getChildDerivationPath(walletDerivationPath: string, accountDerivationPath?: string): Promise<string | undefined> {
    // WalletDerivationPath is from us, what the user used to create his account
    // AccountDerivationPath is the more specific

    if (!accountDerivationPath) {
      return undefined
    }

    let normalizedDerivationPath: string = accountDerivationPath
    if (!normalizedDerivationPath.startsWith('m')) {
      normalizedDerivationPath = `m/${normalizedDerivationPath}`
    }

    if (normalizedDerivationPath !== walletDerivationPath && !normalizedDerivationPath.startsWith(walletDerivationPath + '/')) {
      throw new Error('Derivation paths do not match!')
    }

    return normalizedDerivationPath === walletDerivationPath ? undefined : normalizedDerivationPath.slice(walletDerivationPath.length + 1)
  }
}
