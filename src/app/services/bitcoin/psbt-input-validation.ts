import { MainProtocolSymbols } from '@airgap/coinlib-core'
import { Psbt, Transaction } from '@airgap/coinlib-core/dependencies/src/bitcoinjs-lib-6.1.7/src/index'

const MAX_PSBT_BYTES = 2 * 1024 * 1024
const MAX_INPUTS_OR_OUTPUTS = 1000
const MAX_SATOSHIS = 21_000_000 * 100_000_000

export class PsbtInputValidationError extends Error {
  constructor(reason: string) {
    super(`Invalid Bitcoin PSBT input data: ${reason} Recreate the request with complete, consistent UTXO data.`)
    this.name = 'PsbtInputValidationError'
  }
}

function fail(reason: string): never { throw new PsbtInputValidationError(reason) }
function amount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SATOSHIS) fail('Invalid input or output amount.')
  return value
}
function add(total: number, value: number): number {
  const result = total + amount(value)
  if (!Number.isSafeInteger(result) || result > MAX_SATOSHIS) fail('Input or output total exceeds the Bitcoin supply.')
  return result
}

/** Check the same prevouts used by both the installed detail renderer and signer. */
export function validatePsbtTransactionInputs(identifier: string, unsigned: unknown): void {
  if (![MainProtocolSymbols.BTC, MainProtocolSymbols.BTC_SEGWIT, MainProtocolSymbols.BTC_TAPROOT].includes(identifier as MainProtocolSymbols)) return
  try {
    const encoded = (unsigned as { transaction?: { psbt?: unknown } })?.transaction?.psbt
    if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > MAX_PSBT_BYTES * 2 ||
        encoded.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(encoded)) fail('A supported PSBT of at most 2 MiB is required.')
    const psbt = Psbt.fromHex(encoded)
    if (psbt.txInputs.length === 0 || psbt.txOutputs.length === 0 ||
        psbt.txInputs.length > MAX_INPUTS_OR_OUTPUTS || psbt.txOutputs.length > MAX_INPUTS_OR_OUTPUTS ||
        psbt.data.inputs.length !== psbt.txInputs.length) fail('Unsupported input or output count.')
    const outpoints = new Set<string>()
    let inputTotal = 0
    for (let index = 0; index < psbt.data.inputs.length; index++) {
      const input = psbt.data.inputs[index]
      const reference = psbt.txInputs[index]
      const outpoint = `${reference.hash.toString('hex')}:${reference.index}`
      if (outpoints.has(outpoint)) fail('Duplicate input outpoint.')
      outpoints.add(outpoint)
      let previousOutput: { value: number; script: Buffer } | undefined
      if (input.nonWitnessUtxo !== undefined) {
        const previous = Transaction.fromBuffer(input.nonWitnessUtxo)
        if (!previous.getHash().equals(reference.hash)) fail('The full previous transaction does not match the input transaction hash.')
        if (!Number.isInteger(reference.index) || reference.index < 0 || reference.index >= previous.outs.length) {
          fail('The input output index is absent from the full previous transaction.')
        }
        previousOutput = previous.outs[reference.index]
        amount(previousOutput.value)
      }
      if (input.witnessUtxo !== undefined) {
        amount(input.witnessUtxo.value)
        if (previousOutput && (previousOutput.value !== input.witnessUtxo.value || !previousOutput.script.equals(input.witnessUtxo.script))) {
          fail('Witness and full previous-transaction amounts or scripts disagree.')
        }
      }
      // The installed legacy signer authenticates the complete previous transaction.
      if (identifier === MainProtocolSymbols.BTC && !previousOutput) fail('Legacy Bitcoin inputs require the full previous transaction.')
      // The installed Segwit/Taproot detail renderers read witnessUtxo amounts only.
      if (identifier !== MainProtocolSymbols.BTC && !input.witnessUtxo) fail('Segwit and Taproot inputs require witness UTXO data for review.')
      const output = previousOutput ?? input.witnessUtxo
      if (!output || output.script.length === 0 || output.script.length > 10000) fail('Missing or unsupported previous-output script.')
      inputTotal = add(inputTotal, output.value)
    }
    const outputTotal = psbt.txOutputs.reduce((total, output) => add(total, output.value), 0)
    if (outputTotal > inputTotal) fail('Outputs exceed the supplied input total.')
  } catch (error) {
    if (error instanceof PsbtInputValidationError) throw error
    fail('Malformed or unsupported PSBT.')
  }
}
