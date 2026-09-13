/**
 * Runtime stub of `@deepseek-ai/dsh-llm` for the vitest environment: message
 * factory with a stable identity (the host deep-freezes; tests do not need
 * the freeze semantics).
 */
import { randomUUID } from 'node:crypto'

export function createUserMessage(input) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [...input.content],
    source: { ...input.source },
  }
}

export class HarnessError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'HarnessError'
  }
}
