import { Injectable } from '@angular/core'
import { ActivatedRouteSnapshot, CanActivate, CanActivateChild, Router, RouterStateSnapshot, UrlTree } from '@angular/router'
import { NavigationService } from './navigation.service'

@Injectable({ providedIn: 'root' })
export class WalletRouteGuard implements CanActivate, CanActivateChild {
  constructor(private readonly navigation: NavigationService, private readonly router: Router) {}

  public canActivate(_route: ActivatedRouteSnapshot, state: RouterStateSnapshot): boolean | UrlTree {
    return this.navigation.canActivate(state.url) || this.router.parseUrl('/tabs/tab-secrets')
  }

  public canActivateChild(route: ActivatedRouteSnapshot, state: RouterStateSnapshot): boolean | UrlTree {
    return this.canActivate(route, state)
  }
}
