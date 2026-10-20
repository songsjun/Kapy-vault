// Error messages and stacks can embed secret material (e.g. a failing call's arguments).
// Strip anything shaped like a key, seed or mnemonic before it is persisted or copied.
const REDACTIONS: [RegExp, string][] = [
  // hex encoded keys, seeds and entropy
  [/\b(?:0x)?[0-9a-fA-F]{32,}\b/g, '[redacted-hex]'],
  // base58 extended keys, WIF private keys and similar
  [/\b[1-9A-HJ-NP-Za-km-z]{50,}\b/g, '[redacted-base58]'],
  // 12 or more consecutive lowercase words, as in BIP39 mnemonics and recovery shares
  [/\b(?:[a-z]{3,8}\s+){11,}[a-z]{3,8}\b/g, '[redacted-words]']
]

export function redactSensitive(text: string | undefined): string | undefined {
  if (typeof text !== 'string') {
    return text
  }

  return REDACTIONS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text)
}
