/** Extracts a plain-Hebrew message from any error our modules throw. */
export function errorMessage(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'userMessage' in e && typeof (e as { userMessage: unknown }).userMessage === 'string') {
    return (e as { userMessage: string }).userMessage
  }
  return fallback
}

/** Logs the technical detail for debugging (the user sees the Hebrew message). */
export function logError(context: string, e: unknown): void {
  console.error(`[rubedo] ${context}`, e)
}
