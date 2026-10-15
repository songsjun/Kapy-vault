import { assertNever, UIAction, UIActionStatus, UiEventService, UIResource, UIResourceStatus } from '@airgap/angular-core'
import { AirGapWallet, IAirGapTransaction } from '@airgap/coinlib-core'
import { Component, OnDestroy } from '@angular/core'
import { ModalController } from '@ionic/angular'
import { AlertOptions, LoadingOptions, ModalOptions, OverlayEventDetail } from '@ionic/core'
import { Store } from '@ngrx/store'
import { NavigationService } from 'src/app/services/navigation/navigation.service'
import { Observable, Subject } from 'rxjs'
import { debounceTime, distinctUntilChanged, takeUntil } from 'rxjs/operators'

import { ErrorCategory, handleErrorLocal } from '../../services/error-handler/error-handler.service'
import { SelectAccountPage } from '../select-account/select-account.page'
import { WalletAccessService } from '../../services/wallet-access/wallet-access.service'

import * as actions from './deserialized-detail.actions'
import * as fromDeserializedDetail from './deserialized-detail.reducer'
import { Alert, Modal, Mode, Task, UnsignedMessage } from './deserialized.detail.types'

type ModalOnDismissAction = (modalData: OverlayEventDetail<unknown>) => Promise<void>

@Component({
  selector: 'airgap-deserialized-detail',
  templateUrl: './deserialized-detail.page.html',
  styleUrls: ['./deserialized-detail.page.scss']
})
export class DeserializedDetailPage implements OnDestroy {
  public signingWallet: AirGapWallet | undefined
  public secretLabel: string | undefined
  public readonly mode$: Observable<Mode | undefined>
  public readonly title$: Observable<string>
  public readonly button$: Observable<string | undefined>

  public readonly transactionsDetails$: Observable<UIResource<IAirGapTransaction[]>>
  public readonly messages$: Observable<UIResource<UnsignedMessage[]>>
  public readonly rawData$: Observable<UIResource<string>>

  public readonly loader$: Observable<(UIAction<Task> & { userInput: actions.UserInput }) | undefined>
  public readonly alert$: Observable<UIAction<Alert> | undefined>
  public readonly modal$: Observable<UIAction<Modal> | undefined>

  public readonly Mode: typeof Mode = Mode
  public readonly UIResourceStatus: typeof UIResourceStatus = UIResourceStatus

  private loadingElement: HTMLIonLoadingElement | undefined
  private alertElement: HTMLIonAlertElement | undefined
  private modalElement: HTMLIonModalElement | undefined
  private contextId: number
  private pageActive = false
  private readonly ngDestroyed$: Subject<void> = new Subject()

  constructor(
    private readonly store: Store<fromDeserializedDetail.State>,
    private readonly uiEventService: UiEventService,
    private readonly modalController: ModalController,
    private readonly navigationService: NavigationService,
    private readonly access: WalletAccessService
  ) {
    const state = this.navigationService.getState()
    this.contextId = state.contextId
    this.access.changes$.pipe(takeUntil(this.ngDestroyed$)).subscribe((context) => {
      if (!context || context.epoch !== this.contextId) {
        this.store.dispatch(actions.viewClosed())
        this.signingWallet = undefined
        this.secretLabel = undefined
        this.loadingElement?.dismiss().catch(() => undefined)
        this.alertElement?.dismiss().catch(() => undefined)
        this.modalElement?.dismiss().catch(() => undefined)
      }
    })
    if (state.transactionInfos && state.transactionInfos[0]) {
      const transactionInfos = state.transactionInfos
      this.signingWallet = transactionInfos[0].wallet
      this.secretLabel = transactionInfos[0].secret?.label
    }

    this.mode$ = this.store.select(fromDeserializedDetail.selectMode)
    this.title$ = this.store.select(fromDeserializedDetail.selectTitle)
    this.button$ = this.store.select(fromDeserializedDetail.selectButton)

    this.loader$ = this.store.select(fromDeserializedDetail.selectLoader)
    this.alert$ = this.store.select(fromDeserializedDetail.selectAlert)
    this.modal$ = this.store.select(fromDeserializedDetail.selectModal)

    this.transactionsDetails$ = this.store.select(fromDeserializedDetail.selectTransactionsDetails)
    this.messages$ = this.store.select(fromDeserializedDetail.selectMessagesData)

    this.rawData$ = this.store.select(fromDeserializedDetail.selectRaw)

    // FIXME [#210] set debounce time
    this.loader$.pipe(debounceTime(0), distinctUntilChanged(), takeUntil(this.ngDestroyed$)).subscribe(this.showOrHideLoader.bind(this))
    this.alert$.pipe(takeUntil(this.ngDestroyed$)).subscribe(this.showOrDismissAlert.bind(this))
    this.modal$.pipe(takeUntil(this.ngDestroyed$)).subscribe(this.showOrDismissModal.bind(this))

  }

  public ionViewWillEnter(): void {
    this.pageActive = true
    this.contextId = this.navigationService.getState().contextId
    this.store.dispatch(actions.viewInitialization())
  }
  public ionViewWillLeave(): void { this.pageActive = false; this.store.dispatch(actions.viewClosed()) }

  public ngOnDestroy(): void {
    this.pageActive = false
    this.store.dispatch(actions.viewClosed())
    this.ngDestroyed$.next()
    this.ngDestroyed$.complete()
  }

  public continue(): void {
    if (!this.isCurrent()) return
    this.store.dispatch(actions.approved())
  }

  private isCurrent(): boolean {
    try { this.access.assertContext(this.contextId); return this.pageActive } catch { return false }
  }

  private async showOrHideLoader(task: (UIAction<Task> & { userInput: actions.UserInput }) | undefined): Promise<void> {
    this.loadingElement?.dismiss().catch(handleErrorLocal(ErrorCategory.IONIC_LOADER))
    if (task?.status === UIActionStatus.PENDING && this.isCurrent()) {
      const element = await this.uiEventService.getTranslatedLoader(this.getLoaderData(task.value))
      if (!this.isCurrent()) { element.dismiss().catch(() => undefined); return }
      this.loadingElement = element

      // return this.loadingElement.present().catch(handleErrorLocal(ErrorCategory.IONIC_LOADER))

      // FIXME [#210]: replace with the above once the performance issue is resolved
      await this.loadingElement.present().catch(handleErrorLocal(ErrorCategory.IONIC_LOADER))
      if (!this.isCurrent()) { this.loadingElement.dismiss().catch(() => undefined); return }
      this.store.dispatch(actions.continueApproved({ userInput: task.userInput }))
      // [#210]
    } else {
      this.loadingElement = undefined
    }
  }

  private async showOrDismissAlert(alert: UIAction<Alert> | undefined): Promise<void> {
    this.alertElement?.dismiss().catch(handleErrorLocal(ErrorCategory.IONIC_ALERT))
    if (alert?.status === UIActionStatus.PENDING && this.isCurrent()) {
      const element = await this.uiEventService.getTranslatedAlert(this.getAlertData(alert.value))
      if (!this.isCurrent()) { element.dismiss().catch(() => undefined); return }
      this.alertElement = element
      this.alertElement.present().catch(handleErrorLocal(ErrorCategory.IONIC_ALERT))

      return this.alertElement
        .onWillDismiss()
        .then(() => {
          if (this.isCurrent()) this.store.dispatch(actions.alertDismissed({ id: alert.id }))
        })
        .catch(handleErrorLocal(ErrorCategory.IONIC_ALERT))
    } else {
      this.alertElement = undefined
    }
  }

  private async showOrDismissModal(modal: UIAction<Modal> | undefined): Promise<void> {
    this.modalElement?.dismiss().catch(handleErrorLocal(ErrorCategory.IONIC_MODAL))
    if (modal?.status === UIActionStatus.PENDING && this.isCurrent()) {
      const [modalOptions, onDismissAction]: [ModalOptions, ModalOnDismissAction] = this.getModalData(modal.value)
      const element = await this.modalController.create(modalOptions)
      if (!this.isCurrent()) { element.dismiss().catch(() => undefined); return }
      this.modalElement = element
      this.modalElement.present().catch(handleErrorLocal(ErrorCategory.IONIC_MODAL))

      return this.modalElement
        .onWillDismiss()
        .then(async (data: OverlayEventDetail<unknown>): Promise<void> => {
          if (!this.isCurrent()) return
          this.store.dispatch(actions.modalDismissed({ id: modal.id }))

          return onDismissAction(data)
        })
        .catch(handleErrorLocal(ErrorCategory.IONIC_MODAL))
    } else {
      this.modalElement = undefined
    }
  }

  private getLoaderData(task: Task): LoadingOptions {
    switch (task) {
      case 'signTransaction':
        return this.signTransactionLoader()
      case 'signMessage':
        return this.signMessageLoader()
      case 'generic':
        return this.genericLoader()
      default:
        assertNever('getLoaderData', task)
    }
  }

  private signTransactionLoader(): LoadingOptions {
    return {
      message: 'deserialized-detail.loader.sign-transaction.message'
    }
  }

  private signMessageLoader(): LoadingOptions {
    return {
      message: 'deserialized-detail.loader.sign-message.message'
    }
  }

  private genericLoader(): LoadingOptions {
    return {
      message: 'deserialized-detail.loader.generic.message'
    }
  }

  private getAlertData(alert: Alert): AlertOptions {
    switch (alert.type) {
      case 'secretNotFound':
        return this.secretNotFoundErrorAlert()
      case 'unknownError':
        return this.unknownErrorAlert(alert.message)
      default:
        assertNever('getAlertData', alert)
    }
  }

  private secretNotFoundErrorAlert(): AlertOptions {
    return {
      header: 'deserialized-detail.alert.secret-not-found-error.header',
      message: 'deserialized-detail.alert.secret-not-found-error.message',
      backdropDismiss: false,
      buttons: [
        {
          text: 'deserialized-detail.alert.secret-not-found-error.button_label'
        }
      ]
    }
  }

  private unknownErrorAlert(message?: string): AlertOptions {
    return {
      header: 'deserialized-detail.alert.unknown-error.header',
      message: message ?? 'deserialized-detail.alert.unknown-error.message',
      backdropDismiss: true,
      buttons: [
        {
          text: 'deserialized-detail.alert.unknown-error.button_label'
        }
      ]
    }
  }

  private getModalData(modal: Modal): [ModalOptions, ModalOnDismissAction] {
    switch (modal) {
      case 'selectSigningAccount':
        return this.selectSigningAccountModal()
      default:
        assertNever('getModalData', modal)
    }
  }

  private selectSigningAccountModal(): [ModalOptions, ModalOnDismissAction] {
    const options: ModalOptions = {
      component: SelectAccountPage,
      componentProps: { type: 'message-signing' }
    }

    const action: ModalOnDismissAction = async (modalData: OverlayEventDetail<unknown>): Promise<void> => {
      if (modalData.data === undefined) {
        return
      }

      // Account selection occurs before loading the request, within the current wallet context.
      this.store.dispatch(actions.unknownError({ message: 'Select the account and scan the request again.' }))
    }

    return [options, action]
  }
}
