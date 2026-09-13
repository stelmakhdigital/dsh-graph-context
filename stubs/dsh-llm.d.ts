/**
 * Type stub for `@deepseek-ai/dsh-llm`: the immutable message representation
 * and content-block vocabulary a plugin uses to build injected context.
 * Faithful to the host: `Message` carries a stable id, role, content blocks,
 * and a producer source; `createUserMessage` assigns the identity.
 */
declare module '@deepseek-ai/dsh-llm' {
  export type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue }

  export interface JsonSchemaNode {
    type?: string
    oneOf?: JsonSchemaNode[]
    properties?: Record<string, JsonSchemaNode>
    required?: string[]
    additionalProperties?: boolean
    items?: JsonSchemaNode
    enum?: (string | number | boolean | null)[]
    const?: string | number | boolean | null
    description?: string
    title?: string
    default?: JsonValue
    examples?: JsonValue
  }

  export interface TextBlock {
    type: 'text'
    text: string
  }

  export interface ToolCallBlock {
    type: 'tool-call'
    id: string
    name: string
    arguments: JsonValue
  }

  export interface ToolResultBlock {
    type: 'tool-result'
    toolCallId: string
    content: ContentBlock[]
    isError?: boolean
  }

  export interface ReasoningBlock {
    type: 'reasoning'
    text: string
  }

  /** Merge-extensible content block; the plugin only produces text blocks. */
  export type ContentBlock =
    | TextBlock
    | ToolCallBlock
    | ToolResultBlock
    | ReasoningBlock
    | { type: string; [key: string]: unknown }

  /** Producer attribution. Plugins add their own `kind`s via the host map. */
  export interface PluginMessageSource {
    kind: 'plugin'
    plugin: string
    [key: string]: unknown
  }

  export type MessageSource =
    | { kind: 'user' }
    | PluginMessageSource
    | { kind: 'model'; [key: string]: unknown }
    | { kind: 'tool'; [key: string]: unknown }

  export interface Message {
    readonly id: string
    readonly role: 'system' | 'user' | 'assistant'
    readonly content: readonly ContentBlock[]
    readonly source: MessageSource
  }

  export interface UserMessage extends Message {
    readonly role: 'user'
  }

  /**
   * Create one identified user-role message (the host deep-freezes it).
   * `id` and `role` are assigned by the factory.
   */
  export function createUserMessage(input: {
    content: readonly ContentBlock[]
    source: PluginMessageSource
    id?: never
    role?: never
  }): UserMessage

  export class HarnessError extends Error {
    constructor(message: string, options?: { cause?: unknown })
  }
}

export {}
