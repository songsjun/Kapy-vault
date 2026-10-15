import { IACMessageDefinitionObjectV3 } from '@airgap/serializer'
import { Injectable } from '@angular/core'
import { Actions, createEffect, ofType } from '@ngrx/effects'
import { Action, Store } from '@ngrx/store'
import { from, of } from 'rxjs'
import { catchError, filter, first, switchMap, tap, withLatestFrom } from 'rxjs/operators'

import { MnemonicSecret } from '../../models/secret'
import { InteractionOperationType, InteractionService } from '../../services/interaction/interaction.service'
import { MigrationService } from '../../services/migration/migration.service'
import { SecretsService } from '../../services/secrets/secrets.service'
import { WalletAccessService } from '../../services/wallet-access/wallet-access.service'
import { ShareUrlService } from '../../services/share-url/share-url.service'

import * as actions from './account-share-select.actions'
import * as fromAccountShareSelect from './account-share-select.reducers'

@Injectable()
export class AccountShareSelectEffects {
  public secrets$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.viewInitialization),
      switchMap(() => {
        const secret = this.access.getCurrentSecret()
        if (!secret) return of(actions.initialDataLoaded({ secrets: [] }))
        const current = MnemonicSecret.init(secret)
        current.wallets = this.access.getWallets(secret)
        return of(actions.initialDataLoaded({ secrets: [current] }))
      })
    )
  )

  public shareUrl$ = createEffect(() =>
    this.actions$.pipe(
      ofType(actions.syncButtonClicked),
      withLatestFrom(this.store.select(fromAccountShareSelect.selectCheckedSecrets)),
      filter(([_, checkedSecrets]) => checkedSecrets.length > 0),
      switchMap(([_, checkedSecrets]) => from(this.generateShareUrl(checkedSecrets)).pipe(first(), catchError(() => of(actions.viewInitialization()))))
    )
  )

  public sync$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(actions.shareUrlGenerated, actions.migrationAlertAccepted),
        tap((action) => {
          try { this.syncAccounts(action.shareUrl, action.contextId) } catch { /* Discard an expired profile export. */ }
        })
      ),
    { dispatch: false }
  )

  constructor(
    private readonly actions$: Actions,
    private readonly store: Store<fromAccountShareSelect.State>,
    _secretsService: SecretsService,
    private readonly shareUrlService: ShareUrlService,
    private readonly interactionService: InteractionService,
    _migrationService: MigrationService,
    private readonly access: WalletAccessService
  ) {}

  private async generateShareUrl(secrets: MnemonicSecret[]): Promise<Action> {
    const contextId = this.access.getContextId()
    const shareUrl = await this.shareUrlService.generateShareSecretsURL(secrets)
    this.access.assertContext(contextId)
    return actions.shareUrlGenerated({ shareUrl, contextId })
  }

  private syncAccounts(shareUrl: IACMessageDefinitionObjectV3[], contextId: number): void {
    this.access.assertContext(contextId)
    this.interactionService.startInteraction({
      contextId,
      operationType: InteractionOperationType.WALLET_SYNC,
      iacMessage: shareUrl
    }).catch(() => undefined)
  }
}
