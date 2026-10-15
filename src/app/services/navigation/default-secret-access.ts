import { MnemonicSecret } from '../../models/secret'
import { NavigationService } from './navigation.service'

// Page instances can outlive a navigation in Ionic. Keep their original grant,
// so opening the same Secret later never revives an old page or async result.
export class DefaultSecretAccess {
  private readonly epoch: number
  private readonly unregister: () => void

  constructor(private readonly navigation: NavigationService, private readonly secret: MnemonicSecret, cleanup: () => void) {
    this.epoch = navigation.captureDefaultAccess(secret)
    this.unregister = navigation.registerSensitiveCleanup(cleanup)
  }

  public assert(): void { this.navigation.assertDefaultAccess(this.epoch, this.secret) }
  public dispose(): void { this.unregister() }
}
