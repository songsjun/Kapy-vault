export type WalletRoutePolicy = 'public' | 'wallet' | 'default' | 'draft'

export function navigationPath(url: string): string {
  return '/' + url.split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, '')
}

const walletRoutes = new Set([
  '/tabs/tab-scan', '/accounts-list', '/account-add', '/account-address', '/address-explorer',
  '/account-share', '/account-share-select', '/select-account', '/deserialized-detail',
  '/transaction-signed', '/interaction-selection', '/migration', '/bitcoin-multisig'
])
const defaultRoutes = new Set([
  '/secret-edit', '/bip85-generate', '/bip85-show', '/social-recovery-setup',
  '/social-recovery-show-share', '/social-recovery-validate-share',
  '/social-recovery-generate-intro', '/social-recovery-generate-setup', '/social-recovery-generate-rules',
  '/social-recovery-generate-share-show', '/social-recovery-generate-share-validate', '/social-recovery-generate-finish'
])
const draftRoutes = new Set(['/secret-rules', '/secret-show', '/secret-validate', '/secret-add', '/social-recovery-import-success'])
export const draftEntryRoutes = new Set([
  '/secret-generate', '/secret-generate-dice', '/secret-generate-coin-flip', '/secret-import',
  '/social-recovery-import', '/social-recovery-import-share-validate'
])

export function walletRoutePolicy(url: string): WalletRoutePolicy {
  const path = navigationPath(url)
  return defaultRoutes.has(path) ? 'default' : walletRoutes.has(path) ? 'wallet' : draftRoutes.has(path) ? 'draft' : 'public'
}
