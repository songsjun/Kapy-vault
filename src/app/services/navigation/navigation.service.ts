import { Location } from '@angular/common'
import { Injectable } from '@angular/core'
import { NavigationBehaviorOptions, NavigationStart, Router } from '@angular/router'
import { NavController } from '@ionic/angular'
import { App } from '@capacitor/app'

import { Identifiable } from '../../models/identifiable'
import { MnemonicSecret } from '../../models/secret'
import { WalletAccessService } from '../wallet-access/wallet-access.service'
import { draftEntryRoutes, navigationPath, walletRoutePolicy } from './wallet-route-policy'

interface State {
  // tslint:disable-next-line: no-any
  [key: string]: any
}

interface AuthorizedState {
  state: State
  epoch?: number
  draftSecret?: MnemonicSecret
  rootExport: boolean
}

const rootPath: string = '/tabs/tab-secrets'
const settingsPath: string = '/tabs/tab-settings'
const scanPath: string = '/tabs/tab-scan'

const paths: { path: string; prevPath: string }[] = [
  { path: settingsPath, prevPath: rootPath },
  { path: '/about', prevPath: settingsPath },
  { path: '/qr-settings', prevPath: settingsPath },
  { path: '/languages-selection-settings', prevPath: settingsPath },
  { path: '/wordlist', prevPath: settingsPath },
  { path: '/error-history', prevPath: settingsPath },
  { path: '/contact-book-onboarding', prevPath: settingsPath },
  { path: '/contact-book-contacts', prevPath: settingsPath },
  { path: '/contact-book-contacts-detail', prevPath: '/contact-book-contacts' },
  { path: scanPath, prevPath: rootPath },
  { path: '/accounts-list', prevPath: rootPath },
  { path: '/account-address', prevPath: '/accounts-list' },
  { path: '/secret-setup', prevPath: rootPath },
  { path: '/contact-book-scan', prevPath: '/contact-book-contacts-detail' }
]

@Injectable({
  providedIn: 'root'
})
export class NavigationService {
  private state: State = {}
  private stateRoute?: string
  private stateEpoch?: number
  private draftSecret?: MnemonicSecret
  private rootExport: boolean = false
  private readonly sensitiveCleanup = new Set<() => void>()
  private contextEpoch?: number
  private persistedSecretIds = new Set<string>()
  private readonly routeStates = new Map<string, AuthorizedState>()
  private secretsNavigation?: Promise<boolean>
  private revokingForSecrets: boolean = false

  constructor(
    private readonly router: Router,
    private readonly location: Location,
    private readonly navCtrl: NavController,
    private readonly access: WalletAccessService
  ) {
    this.access.changes$.subscribe((context) => {
      if (context?.epoch !== this.contextEpoch || !context) {
        this.clearSensitiveState()
      }
      this.contextEpoch = context?.epoch
    })
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart && navigationPath(event.url) === rootPath) {
        this.access.lock()
        this.clearSensitiveState()
      }
    })
  }

  public async routeWithIdentifiableObject(router: Router, route: string, object: Identifiable): Promise<boolean> {
    return router.navigate([route, object.getIdentifier()])
  }

  public route(route: string, clearStack: boolean = false): Promise<boolean> {
    if (navigationPath(route) === rootPath) { return this.routeToSecretsTab(true) }
    return this.router.navigateByUrl(route, { replaceUrl: clearStack })
  }

  public async routeWithState(route: string, object: State, options?: NavigationBehaviorOptions): Promise<boolean> {
    this.setState(route, object)

    return this.router.navigateByUrl(route, options)
  }

  public async routeWithStateAsRoot(route: string, object: State): Promise<boolean> {
    this.setState(route, object)

    return this.navCtrl.navigateRoot(route)
  }

  public back(): void {
    this.location.back()
  }

  public routeBack(route: string): void {
    this.navCtrl.navigateBack(route)
  }

  public getState(): State {
    this.assertStateAccess()
    return this.state
  }

  public registerSensitiveCleanup(cleanup: () => void): () => void {
    this.sensitiveCleanup.add(cleanup)
    return () => this.sensitiveCleanup.delete(cleanup)
  }

  public setPersistedSecretIds(ids: string[]): void {
    this.persistedSecretIds = new Set(ids)
  }

  public clearSensitiveState(): void {
    this.state = {}
    this.stateRoute = undefined
    this.stateEpoch = undefined
    this.draftSecret = undefined
    this.rootExport = false
    this.routeStates.clear()
    this.sensitiveCleanup.forEach((cleanup) => cleanup())
  }

  public captureDefaultAccess(secret: MnemonicSecret): number {
    this.access.requireDefault(secret)
    return this.access.getContextId()
  }

  public assertDefaultAccess(epoch: number, secret?: MnemonicSecret): void {
    this.access.assertContext(epoch)
    this.access.requireDefault(secret)
  }

  public assertSecretDisplay(secret: MnemonicSecret): void {
    this.assertStateAccess()
    if (this.state.secret !== secret || (!this.draftSecret && !this.rootExport)) {
      throw new Error('This recovery phrase is no longer authorized')
    }
    if (this.rootExport) { this.access.requireDefault() }
  }

  public canActivate(url: string): boolean {
    try {
      const policy = walletRoutePolicy(url)
      if (policy === 'public') { return true }
      if (policy === 'wallet' && navigationPath(url) === scanPath) {
        this.access.requireUnlocked()
        return true
      }
      if (this.stateRoute !== navigationPath(url)) {
        const saved = this.routeStates.get(navigationPath(url))
        if (!saved) { return false }
        if (saved.epoch !== undefined) { this.access.assertContext(saved.epoch) }
        this.state = saved.state
        this.stateEpoch = saved.epoch
        this.draftSecret = saved.draftSecret
        this.rootExport = saved.rootExport
        this.stateRoute = navigationPath(url)
      }
      this.assertStateAccess()
      if (policy === 'draft') {
        this.assertSecretDisplay(this.state.secret)
      } else {
        if (this.stateEpoch === undefined) { return false }
        this.access.requireUnlocked(this.state.secret)
        if (policy === 'default') { this.access.requireDefault(this.state.secret) }
        const wallet = this.state.wallet
        if (wallet && !this.access.requireUnlocked().wallets.includes(wallet)) { return false }
      }
      return true
    } catch (_) { return false }
  }

  private setState(route: string, object: State): void {
    const source = navigationPath(this.router.url)
    const policy = walletRoutePolicy(route)
    const previousDraft = this.draftSecret
    const previousRootExport = this.rootExport
    this.assertStateAccess()
    let draft: MnemonicSecret | undefined
    let rootExport = false
    let epoch: number | undefined
    if (policy === 'draft') {
      if (draftEntryRoutes.has(source) && object.secret?.secretHex && !this.access.isConfigured(object.secret) &&
          !this.persistedSecretIds.has(object.secret.id)) {
        draft = object.secret
      } else if (previousDraft === object.secret) {
        draft = previousDraft
        epoch = this.stateEpoch
      } else if (source === '/bip85-show' && object.secret?.secretHex && !this.access.isConfigured(object.secret)) {
        this.access.requireDefault()
        epoch = this.access.getContextId()
        draft = object.secret
      } else if ((source === '/secret-edit' || previousRootExport) && object.secret?.secretHex) {
        this.access.requireDefault()
        epoch = this.access.getContextId()
        rootExport = true
      } else {
        throw new Error('Start Secret generation or import again')
      }
    } else if (policy !== 'public') {
      this.access.requireUnlocked(object.secret)
      if (policy === 'default') { this.access.requireDefault(object.secret) }
      epoch = this.access.getContextId()
    } else if (this.access.isUnlocked()) {
      epoch = this.access.getContextId()
    }
    this.state = object
    this.stateRoute = navigationPath(route)
    this.stateEpoch = epoch
    this.draftSecret = draft
    this.rootExport = rootExport
    if (policy !== 'public') {
      this.routeStates.set(this.stateRoute, { state: object, epoch, draftSecret: draft, rootExport })
    }
  }

  private assertStateAccess(): void {
    if (this.stateEpoch !== undefined) { this.access.assertContext(this.stateEpoch) }
  }

  public routeToSecretsTab(clearStack: boolean = false): Promise<boolean> {
    if (this.secretsNavigation) {
      this.revokeForSecrets()
      return this.secretsNavigation
    }
    let complete: (result: boolean | PromiseLike<boolean>) => void
    let fail: (error: unknown) => void
    const pending = new Promise<boolean>((resolve, reject) => { complete = resolve; fail = reject })
    // Publish the pending return before lock(): its synchronous subscribers can
    // also request the root page while Ionic is still showing the account page.
    this.secretsNavigation = pending
    const clear = () => { if (this.secretsNavigation === pending) { this.secretsNavigation = undefined } }
    pending.then(clear, clear)
    try {
      this.revokeForSecrets()
      // Drop Ionic's cached detail pages as well as browser history for a closed wallet.
      complete(this.navCtrl.navigateRoot(rootPath, { replaceUrl: clearStack }))
    } catch (error) {
      fail(error)
    }
    return pending
  }

  private revokeForSecrets(): void {
    if (this.revokingForSecrets) { return }
    this.revokingForSecrets = true
    try {
      // Repeated requests must still cancel a newer unlock operation. Only
      // synchronous feedback from the same revocation is suppressed.
      this.access.lock()
      this.clearSensitiveState()
    } finally {
      this.revokingForSecrets = false
    }
  }

  public routeToScanTab(clearStack: boolean = false): Promise<boolean> {
    return this.router.navigateByUrl(scanPath, { replaceUrl: clearStack })
  }

  public routeToSettingsTab(clearStack: boolean = false): Promise<boolean> {
    return this.router.navigateByUrl(settingsPath, { replaceUrl: clearStack })
  }

  handleAndroidBackNavigation(currentPath: string) {
    if (currentPath === rootPath) {
      App.exitApp()
      return
    }

    const prevpath = paths.find((p) => currentPath.includes(p.path))
    if (prevpath) {
      this.route(prevpath.prevPath).catch((error) => console.error('error related to navigation', error))
    }
  }
}
