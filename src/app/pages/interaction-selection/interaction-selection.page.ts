import { Component, OnInit } from '@angular/core'
import { InteractionType, VaultStorageKey, VaultStorageService } from 'src/app/services/storage/storage.service'

import { ErrorCategory, handleErrorLocal } from '../../services/error-handler/error-handler.service'
import { IInteractionOptions, InteractionCommunicationType, InteractionService } from '../../services/interaction/interaction.service'
import { NavigationService } from '../../services/navigation/navigation.service'
import { Store } from '@ngrx/store'
import { selectTransactionsDetails } from '../deserialized-detail/deserialized-detail.reducer'
import * as fromDeserializedDetail from '../deserialized-detail/deserialized-detail.reducer'
import { ContactsService } from 'src/app/services/contacts/contacts.service'
import { WalletAccessService } from '../../services/wallet-access/wallet-access.service'

@Component({
  selector: 'airgap-interaction-selection',
  templateUrl: './interaction-selection.page.html',
  styleUrls: ['./interaction-selection.page.scss']
})
export class InteractionSelectionPage implements OnInit {
  private interactionOptions: IInteractionOptions
  transactionsDetails$ = this.store.select(selectTransactionsDetails)
  areSuggestionsEnabled: boolean = true

  constructor(
    private readonly navigationService: NavigationService,
    private readonly storageService: VaultStorageService,
    private readonly interactionService: InteractionService,
    private readonly contactService: ContactsService,
    private store: Store<fromDeserializedDetail.State>,
    private readonly access: WalletAccessService
  ) {}

  async ngOnInit() {
    this.areSuggestionsEnabled = await this.contactService.isSuggestionsEnabled()
  }

  public ionViewDidEnter(): void {
    this.interactionOptions = this.navigationService.getState().interactionOptions
  }

  public async selectOfflineDevice(): Promise<void> {
    this.interactionOptions.communicationType = InteractionCommunicationType.QR
    this.goToNextPage()
  }

  public async selectSameDevice(): Promise<void> {
    this.interactionOptions.communicationType = InteractionCommunicationType.DEEPLINK
    this.goToNextPage()
  }

  private async goToNextPage(): Promise<void> {
    this.access.assertContext(this.interactionOptions?.contextId)
    const interactionType = await this.storageService.get(VaultStorageKey.INTERACTION_TYPE)
    this.access.assertContext(this.interactionOptions.contextId)
    if (interactionType === InteractionType.UNDETERMINED) {
      this.goToInteractionSelectionSettingsPage(this.interactionOptions)
    } else {
      this.interactionService.startInteraction(this.interactionOptions)
    }
  }

  private goToInteractionSelectionSettingsPage(interactionOptions: IInteractionOptions): void {
    this.navigationService
      .routeWithState('/interaction-selection-settings', { interactionOptions })
      .catch(handleErrorLocal(ErrorCategory.IONIC_NAVIGATION))
  }
}
