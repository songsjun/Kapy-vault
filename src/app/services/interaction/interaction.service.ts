import { DeeplinkService, QRType } from '@airgap/angular-core'
import { Injectable } from '@angular/core'
import { AirGapWallet, UnsignedTransaction } from '@airgap/coinlib-core'
import { IACMessageDefinitionObjectV3, IACMessageType, MessageSignResponse } from '@airgap/serializer'

import { CompanionApp } from '../../pages/account-address/account-address.page'
import { assertNever } from '../../utils/utils'

import { ErrorCategory, handleErrorLocal } from '../error-handler/error-handler.service'
import { NavigationService } from '../navigation/navigation.service'
import { InteractionType, VaultStorageKey, VaultStorageService } from '../storage/storage.service'
import { WalletAccessService } from '../wallet-access/wallet-access.service'

export enum InteractionCommunicationType {
  QR = 'qr',
  DEEPLINK = 'deeplink'
}

export enum InteractionOperationType {
  WALLET_SYNC = 'walletSync',
  TRANSACTION_BROADCAST = 'transactionBroadcast',
  MESSAGE_SIGN_REQUEST = 'messageSignRequest'
}

export interface IInteractionOptions {
  contextId?: number
  operationType: InteractionOperationType
  iacMessage: IACMessageDefinitionObjectV3[] // remove string
  communicationType?: InteractionCommunicationType
  signedTxs?: string[]
  wallets?: AirGapWallet[]
  transactions?: UnsignedTransaction[]
  messageSignResponse?: MessageSignResponse
  companionApp?: CompanionApp
}

@Injectable({
  providedIn: 'root'
})
export class InteractionService {
  interactionType: InteractionType

  constructor(
    private readonly navigationService: NavigationService,
    private readonly deepLinkService: DeeplinkService,
    private readonly storageService: VaultStorageService,
    private readonly access: WalletAccessService
  ) {
    this.storageService.get(VaultStorageKey.INTERACTION_TYPE).then((type) => (this.interactionType = type))
  }

  resetInteractionType() {
    this.changeInteractionType(InteractionType.ALWAYS_ASK)
  }

  changeInteractionType(newType: InteractionType) {
    this.interactionType = newType
    this.storageService.set(VaultStorageKey.INTERACTION_TYPE, this.interactionType).catch(handleErrorLocal(ErrorCategory.SECURE_STORAGE))
  }

  async getInteractionType() {
    this.interactionType = await this.storageService.get(VaultStorageKey.INTERACTION_TYPE)
    return this.interactionType
  }

  public async startInteraction(interactionOptions: IInteractionOptions): Promise<void> {
    const contextId = interactionOptions.contextId ?? this.access.getContextId()
    this.access.assertContext(contextId)
    interactionOptions = { ...interactionOptions, contextId }
    this.assertMessagesBelongToCurrentWallet(interactionOptions.iacMessage)
    await this.getInteractionType()
    this.access.assertContext(contextId)
    this.assertMessagesBelongToCurrentWallet(interactionOptions.iacMessage)

    if (interactionOptions.communicationType) {
      if (this.interactionType === InteractionType.UNDETERMINED) {
        this.goToInteractionSelectionSettingsPage(interactionOptions)
        return
      }
      if (interactionOptions.communicationType === InteractionCommunicationType.DEEPLINK) {
        await this.startDeeplink(interactionOptions.iacMessage, contextId)
      } else if (interactionOptions.communicationType === InteractionCommunicationType.QR) {
        this.navigateToPageByOperationType(interactionOptions)
      }
    } else if (
      interactionOptions.operationType === InteractionOperationType.WALLET_SYNC &&
      interactionOptions.companionApp &&
      ![QRType.V2, QRType.V3].includes(interactionOptions.companionApp?.qrType)
    ) {
      this.navigateToPageByOperationType(interactionOptions)
    } else {
      switch (this.interactionType) {
        case InteractionType.UNDETERMINED:
          this.goToInteractionSelectionPage(interactionOptions)
          break
        case InteractionType.ALWAYS_ASK:
          this.goToInteractionSelectionPage(interactionOptions)
          break
        case InteractionType.DEEPLINK:
          await this.startDeeplink(interactionOptions.iacMessage, contextId)
          break
        case InteractionType.QR_CODE:
          this.navigateToPageByOperationType(interactionOptions)
          break
        default:
      }
    }
  }

  private goToInteractionSelectionPage(interactionOptions: IInteractionOptions): void {
    this.access.assertContext(interactionOptions.contextId)
    this.navigationService
      .routeWithState('/interaction-selection', { interactionOptions })
      .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }

  private goToInteractionSelectionSettingsPage(interactionOptions: IInteractionOptions): void {
    this.access.assertContext(interactionOptions.contextId)
    this.navigationService
      .routeWithState('/interaction-selection-settings', { interactionOptions })
      .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }

  private navigateToPageByOperationType(interactionOptions: IInteractionOptions): void {
    this.access.assertContext(interactionOptions.contextId)
    if (interactionOptions.operationType === InteractionOperationType.WALLET_SYNC) {
      this.navigationService
        .routeWithState('/account-share', {
          interactionUrl: interactionOptions.iacMessage,
          contextId: interactionOptions.contextId,
          companionApp: interactionOptions.companionApp
        })
        .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
    } else if (interactionOptions.operationType === InteractionOperationType.TRANSACTION_BROADCAST) {
      this.navigationService
        .routeWithState('/transaction-signed', {
          interactionUrl: interactionOptions.iacMessage,
          contextId: interactionOptions.contextId,
          wallets: interactionOptions.wallets,
          signedTxs: interactionOptions.signedTxs,
          transactions: interactionOptions.transactions,
          translationKey: 'transaction-signed'
        })
        .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
    } else if (interactionOptions.operationType === InteractionOperationType.MESSAGE_SIGN_REQUEST) {
      this.navigationService
        .routeWithState('/transaction-signed', {
          interactionUrl: interactionOptions.iacMessage,
          contextId: interactionOptions.contextId,
          translationKey: 'message-signing-request',
          messageSignResponse: interactionOptions.messageSignResponse
        })
        .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
    } else {
      return assertNever('INVALID_OPERATION_TYPE', interactionOptions.operationType)
    }
  }

  private assertMessagesBelongToCurrentWallet(messages: IACMessageDefinitionObjectV3[]): void {
    this.access.requireUnlocked()
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('No current wallet account was selected for export.')
    const wallets = this.access.getWallets()
    for (const message of messages) {
      const payload = message.payload as any
      const publicKey = message.type === IACMessageType.TransactionSignResponse ? payload?.accountIdentifier : payload?.publicKey
      const wallet = wallets.find((candidate) => candidate.publicKey === publicKey)
      if (!wallet) throw new Error('The export does not belong to the currently opened wallet.')
      this.access.assertWallet(wallet)
      if (message.type === IACMessageType.AccountShareResponse) {
        if (payload.groupId !== this.access.getShareGroupId() || payload.derivationPath !== wallet.derivationPath) {
          throw new Error('The account share belongs to another wallet profile.')
        }
      } else if (message.type !== IACMessageType.TransactionSignResponse && message.type !== IACMessageType.MessageSignResponse) {
        throw new Error('This message cannot be exported from the current wallet.')
      }
    }
  }

  private async startDeeplink(iacMessage: IACMessageDefinitionObjectV3[], contextId: number): Promise<void> {
    this.access.assertContext(contextId)
    this.deepLinkService
      .sameDeviceDeeplink(iacMessage)
      .then(() => {
        this.access.assertContext(contextId)
        this.navigationService.routeToSecretsTab().catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
      })
      .catch(handleErrorLocal(ErrorCategory.DEEPLINK_SERVICE))
  }
}
