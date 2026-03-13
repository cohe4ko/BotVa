/** Imagen output token price: $30 per 1M tokens = $0.00003 per token */
export const IMAGE_OUTPUT_TOKEN_PRICE = 0.00003

export function imageTokenCost(outputTokens: number): number {
  return Number((outputTokens * IMAGE_OUTPUT_TOKEN_PRICE).toFixed(4))
}
