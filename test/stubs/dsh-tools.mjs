/**
 * Runtime stub of `@deepseek-ai/dsh-tools` for the vitest environment: the
 * minimal `defineTool` pass-through (the host validates args/outputs; tests
 * exercise the plugin logic by calling `execute` directly).
 */
export function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: options.output,
    execute: options.execute,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.finalizeContent !== undefined ? { finalizeContent: options.finalizeContent } : {}),
  }
}
