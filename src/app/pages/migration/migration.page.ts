import { UIAction, UIActionStatus, UiEventService, UIResource, UIResourceStatus } from '@airgap/angular-core'
import { Component, OnDestroy } from '@angular/core'
import { AlertOptions } from '@ionic/core'
import { Store } from '@ngrx/store'
import { TranslateService } from '@ngx-translate/core'
import { Observable, Subject } from 'rxjs'
import { takeUntil } from 'rxjs/operators'

import { ErrorCategory, handleErrorLocal } from '../../services/error-handler/error-handler.service'

import * as actions from './migration.actions'
import * as fromMigration from './migration.reducers'
import { Alert, MigrationWalletGroup } from './migration.types'

@Component({
  selector: 'airgap-migration',
  templateUrl: './migration.page.html',
  styleUrls: ['./migration.page.scss']
})
export class MigrationPage implements OnDestroy {
  public readonly walletGroups$: Observable<UIResource<MigrationWalletGroup[]>>

  public readonly isRunning$: Observable<boolean>
  public readonly isDone$: Observable<boolean>

  public readonly alert$: Observable<UIAction<Alert> | undefined>

  public readonly UIResourceStatus: typeof UIResourceStatus = UIResourceStatus

  private alertElement: HTMLIonAlertElement

  private readonly ngDestroyed$: Subject<void> = new Subject()

  constructor(
    private readonly store: Store<fromMigration.State>,
    private readonly uiEventService: UiEventService,
    private readonly translateService: TranslateService
  ) {
    this.walletGroups$ = this.store.select(fromMigration.selectMigrationWalletGroups)

    this.isRunning$ = this.store.select(fromMigration.selectIsRunning)
    this.isDone$ = this.store.select(fromMigration.selectIsDone)

    this.alert$ = this.store.select(fromMigration.selectAlert)

    this.alert$.pipe(takeUntil(this.ngDestroyed$)).subscribe(this.showOrDismissAlert.bind(this))
  }

  public ionViewWillEnter(): void {
    this.store.dispatch(actions.viewWillEnter())
  }

  public ionViewDidLeave(): void {
    this.store.dispatch(actions.viewLeft())
  }

  public ngOnDestroy(): void {
    this.ngDestroyed$.next()
    this.ngDestroyed$.complete()
  }

  public run(): void {
    this.store.dispatch(actions.migrationStarted())
  }

  public finish(): void {
    this.store.dispatch(actions.finished())
  }

  private async showOrDismissAlert(alert: UIAction<Alert> | undefined): Promise<void> {
    this.alertElement?.dismiss().catch(handleErrorLocal(ErrorCategory.IONIC_ALERT))
    if (alert?.status === UIActionStatus.PENDING) {
      this.alertElement = await this.uiEventService.getTranslatedAlert(this.getAlertData(alert.value))
      this.alertElement.present().catch(handleErrorLocal(ErrorCategory.IONIC_ALERT))

      return this.alertElement
        .onWillDismiss()
        .then(() => {
          this.store.dispatch(actions.alertDismissed({ id: alert.id }))
        })
        .catch(handleErrorLocal(ErrorCategory.IONIC_ALERT))
    } else {
      this.alertElement = undefined
    }
  }

  private getAlertData(alert: Alert): AlertOptions {
    switch (alert.type) {
      case 'paranoiaInfo':
        return this.paranoiaInfoAlert(alert.label)
      case 'bip39Passphrase':
        return this.unknownErrorAlert('Re-import this legacy Secret with a default wallet password first.')
      case 'unknownError':
        return this.unknownErrorAlert(alert.message)
      default:
        return {}
    }
  }

  private paranoiaInfoAlert(label: string): AlertOptions {
    return {
      header: 'migration.alert.paranoia-info.header',
      message: this.translateService.instant('migration.alert.paranoia-info.message', {
        label
      }),
      backdropDismiss: false,
      buttons: [
        {
          text: 'migration.alert.paranoia-info.button-skip_label',
          handler: (): void => {
            this.store.dispatch(actions.paranoiaRejected())
          }
        },
        {
          text: 'migration.alert.paranoia-info.button-ok_label',
          handler: (): void => {
            this.store.dispatch(actions.paranoiaAccepted())
          }
        }
      ]
    }
  }

  private unknownErrorAlert(message?: string): AlertOptions {
    return {
      header: 'migration.alert.unknown-error.header',
      message: message ?? 'migration.alert.unknown-error.message',
      backdropDismiss: true,
      buttons: [
        {
          text: 'migration.alert.unknown-error.button_label'
        }
      ]
    }
  }
}
