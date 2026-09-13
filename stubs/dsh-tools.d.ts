/**
 * Type stub for `@deepseek-ai/dsh-tools`: the unified tool-definition DSL
 * (`defineTool`) with schema inference, the execution context handed to
 * tool bodies, and the post-execute decision union. Mirrors the host
 * contracts in packages/core/tools (schema.ts / index.ts).
 */
declare module '@deepseek-ai/dsh-tools' {
  import type { Agent } from '@deepseek-ai/dsh-agent'
  import type { ContentBlock, JsonSchemaNode, JsonValue, UserMessage } from '@deepseek-ai/dsh-llm'

  export type { ContentBlock, JsonSchemaNode, JsonValue }

  /** One implicit parameter-root property, optionally required. */
  type ParameterPropertySpec = ValueSchemaSpec & { required?: true }

  /** Tool parameter schema: an implicit open object root. */
  export type ParameterSchemaSpec = { [key: string]: ParameterPropertySpec }

  /** Annotation keywords shared by every author-facing schema node. */
  interface ValueSchemaAnnotations {
    description?: string
    title?: string
    default?: JsonValue
    examples?: JsonValue
  }

  export interface StringValueSchemaSpec extends ValueSchemaAnnotations { type: 'string'; enum?: readonly string[]; const?: string }
  export interface NumberValueSchemaSpec extends ValueSchemaAnnotations { type: 'number'; enum?: readonly number[]; const?: number }
  export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations { type: 'integer'; enum?: readonly number[]; const?: number }
  export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations { type: 'boolean'; enum?: readonly boolean[]; const?: boolean }
  export interface NullValueSchemaSpec extends ValueSchemaAnnotations { type: 'null'; enum?: readonly null[]; const?: null }
  export interface ArrayValueSchemaSpec extends ValueSchemaAnnotations { type: 'array'; items?: ValueSchemaSpec }
  /** Explicit object node: openness is mandatory, never accidental. */
  export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations { type: 'object'; properties?: ParameterSchemaSpec; additionalProperties: boolean }
  export interface JsonValueSchemaSpec extends ValueSchemaAnnotations { type: 'json' }
  export interface OneOfValueSchemaSpec extends ValueSchemaAnnotations { oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]] }

  export type ValueSchemaSpec =
    | StringValueSchemaSpec
    | NumberValueSchemaSpec
    | IntegerValueSchemaSpec
    | BooleanValueSchemaSpec
    | NullValueSchemaSpec
    | ArrayValueSchemaSpec
    | ObjectValueSchemaSpec
    | JsonValueSchemaSpec
    | OneOfValueSchemaSpec

  // ---- inference (simplified mirror of the host's InferArgs/InferValue) ----

  type Simplify<T> = { [K in keyof T]: T[K] } & {}

  type RequiredKeys<S> = { [K in keyof S]: S[K] extends { required: true } ? K : never }[keyof S]

  type InferValueS<S, D extends unknown[] = []> =
    S extends StringValueSchemaSpec ? string
    : S extends NumberValueSchemaSpec ? number
    : S extends IntegerValueSchemaSpec ? number
    : S extends BooleanValueSchemaSpec ? boolean
    : S extends NullValueSchemaSpec ? null
    : S extends { type: 'array'; items?: infer I }
      ? (I extends ValueSchemaSpec ? Array<InferValueS<I, D>> : JsonValue[])
    : S extends { type: 'object'; additionalProperties: false; properties?: infer P }
      ? P extends ParameterSchemaSpec
        ? Simplify<
          & { [K in RequiredKeys<P>]: InferValueS<P[K], D> }
          & { [K in Exclude<keyof P, RequiredKeys<P>>]?: InferValueS<P[K], D> }
          >
        : object
      : S extends { type: 'object'; additionalProperties: true }
        ? Record<string, JsonValue>
      : S extends { oneOf: readonly ValueSchemaSpec[] }
        ? JsonValue
      : S extends JsonValueSchemaSpec
        ? JsonValue
        : JsonValue

  type InferArgsS<S, D extends unknown[] = []> =
    S extends ParameterSchemaSpec
      ? Simplify<
        & { [K in RequiredKeys<S>]: InferValueS<S[K], D> }
        & { [K in Exclude<keyof S, RequiredKeys<S>>]?: InferValueS<S[K], D> }
        >
      : never

  type InferArgs<S> = InferArgsS<S>
  type InferValue<S> = InferValueS<S>

  /**
   * Runtime context handed to a tool implementation after the registry has
   * accepted the execution: immutable identity, the caller agent (the
   * session's cwd lives in `agent.session.header`), and the caller-owned
   * cancellation signal.
   */
  export interface ToolRunContext {
    readonly callId: string
    readonly rootCallId: string
    readonly name: string
    /** Losslessly JSON-serializable parsed arguments. */
    readonly arguments: unknown
    readonly agent?: Agent
    readonly signal: AbortSignal
    readonly parent?: symbol
    readonly token?: symbol
  }

  export type ToolExecution = ToolRunContext

  export interface ToolExecutionResult {
    readonly isError: boolean
    readonly content?: readonly ContentBlock[]
    readonly value?: JsonValue
  }

  /** Accept, replace, or block a normalized dispatch result. */
  export type PostToolDecision =
    | { kind: 'accept'; content?: readonly ContentBlock[]; value?: JsonValue; additionalContexts?: readonly UserMessage[] }
    | { kind: 'block'; feedback: readonly ContentBlock[]; additionalContexts?: readonly UserMessage[] }

  /**
   * Pre-dispatch decision (tools/pre-execute, ordered waterfall).
   * `allow` runs the call; `deny` materializes an error result; `ask` runs
   * only after an approval service allows it. (Mirrors the host's
   * PreToolDecision in packages/core/tools.)
   */
  export type PreToolDecision =
    | { kind: 'allow' }
    | { kind: 'deny'; reason: string }
    | { kind: 'ask'; reason?: string }

  /** Tool-owned canonical output contract. */
  export interface ToolOutputDefinition {
    readonly schema: JsonSchemaNode
    /** Pure projection from validated arguments and value to model content. Must not throw. */
    render(args: unknown, value: JsonValue): ContentBlock[]
    /** Pure replayable presentation projection. */
    presentationMeta?(args: unknown, value: JsonValue): JsonValue
  }

  export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
    /** Model-facing tool name: snake_case, ≤ 64 chars. */
    name: string
    /** Model-facing description: imperative, when to call (vs grep/read). */
    description: string
    parameters: S
    output: {
      schema: O
      render(args: InferArgs<S>, value: InferValue<O>): ContentBlock[]
      presentationMeta?(args: InferArgs<S>, value: InferValue<O>): JsonValue
    }
    execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<O>> | InferValue<O>
    /** Cooperative timeout budget; asserts exec.signal is forwarded. */
    timeoutMs?: number
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
    isConcurrencySafe?(args: InferArgs<S>): boolean
  }

  export interface ToolDefinition {
    readonly name: string
    readonly description: string
    readonly output: ToolOutputDefinition
    execute(args: unknown, exec: ToolRunContext): Promise<JsonValue>
    timeoutMs?: number
    readonly [key: string]: unknown
  }

  /**
   * Define a first-party tool with inferred arguments and strict execution
   * validation. `execute` returns only the canonical value declared by
   * `output.schema`; throwing or returning an invalid value is an error.
   */
  export function defineTool<S extends ParameterSchemaSpec, O extends ValueSchemaSpec>(
    options: DefineToolOptions<S, O>,
  ): ToolDefinition
}

export {}
