/**
 * Type stub for `@deepseek-ai/cordis`: the plugin context a DSH plugin module
 * receives from `apply`. Models the surface this plugin uses — event
 * subscription (emit + waterfall), effects, the logger, and the service
 * accessors (`tools`, `systemPrompt`, optional `settings`).
 *
 * Event payload/decision shapes mirror the host's scoped event map
 * (packages/core/agent runtime-types + packages/core/tools index).
 */
declare module '@deepseek-ai/cordis' {
  import type { Agent, PreStepDecision, Session, SessionStartSource } from '@deepseek-ai/dsh-agent'
  import type { UserMessage } from '@deepseek-ai/dsh-llm'
  import type {
    PostToolDecision,
    PreToolDecision,
    ToolDefinition,
    ToolExecution,
    ToolExecutionResult,
  } from '@deepseek-ai/dsh-tools'

  export interface Logger {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }

  /** One ordered system-prompt section. `order` must be a finite number. */
  export interface PromptSection {
    name: string
    order: number
    text: string
  }

  export interface SystemPromptService {
    /** Register an ordered prompt section in the calling scope; returns the disposer. */
    section(section: PromptSection): () => void
    getSectionOrder(name: string): number
    variable(name: string, resolve: (context: { agent?: Agent }) => unknown): () => void
  }

  export interface ToolsService {
    /** Register a tool; disposing the plugin fiber unregisters it. */
    register(tool: ToolDefinition): void
  }

  /**
   * One tool entry of an assembled prompt (host: dsh-llm `ToolSchema`).
   * ANTI-DRIFT: verified 2026-09-13 against
   * packages/llm/llm/src/types.ts (`name`, `description`, `parameters`).
   */
  export interface ToolSchemaLike {
    readonly name: string
    readonly description?: string
    readonly parameters?: Record<string, unknown>
  }

  /**
   * The assembled prompt handed to the `system-prompt/assemble` waterfall.
   * ANTI-DRIFT: verified 2026-09-13 against
   * packages/core/system-prompt/lib/types/index.d.ts
   * (`sections`, `contexts`, `tools: ToolSchema[]`, `variables`).
   */
  export interface PromptAssembly {
    sections: ReadonlyArray<unknown>
    contexts: ReadonlyArray<unknown>
    tools: ReadonlyArray<ToolSchemaLike>
    variables: Record<string, string | undefined>
  }

  /** Per-assembly context (scope + optional signal). */
  export interface AssembleContext {
    readonly scope?: unknown
    readonly signal?: AbortSignal
  }

  /**
   * A committed session event as observed by plugins (host: dsh-session
   * `SessionEvent`). ANTI-DRIFT: verified 2026-09-13 against the compaction
   * vocabulary (packages/compaction/compaction/lib/types/types.d.ts:
   * `compaction/summary`, `compaction/prune`) and the host subscription
   * precedent (packages/goal, packages/todo: `ctx.on('session/event',
   * (session, event) => …)`).
   */
  export interface SessionEventLike {
    readonly type: string
    readonly data: Record<string, unknown>
  }

  export interface SettingsSectionHooks<T> {
    setSource(source: () => T): void
    onChange(): void
    validate?(value: unknown): T
  }

  export interface SettingsService {
    /**
     * Attach one optional-settings consumer. `ns` must be a lowercase
     * hyphenated identifier.
     */
    installSection<N extends string, T>(
      owner: Context,
      ns: N,
      schema: unknown,
      entry: T,
      hooks: SettingsSectionHooks<T>,
    ): void
  }

  /**
   * Plugin context. The framework waits for every service named in the
   * module's `inject` export before `apply` runs; registrations made through
   * `ctx` are cleaned up when the plugin unloads.
   */
  export interface Context {
    // ---- emit events -------------------------------------------------------
    on(
      event: 'agent/session-start',
      listener: (payload: { agent: Agent; source: SessionStartSource }) => void | Promise<void>,
    ): () => void
    on(
      event: 'agent/turn-stopping',
      listener: (payload: { agent: Agent; turn: number; signal: AbortSignal }) => void | Promise<void>,
    ): () => void
    on(
      event: 'tools/result',
      listener: (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => void,
    ): () => void
    on(
      event: 'agent/created',
      listener: (payload: { agent: Agent }) => void,
    ): () => void
    on(
      event: 'session/event',
      listener: (session: Session, event: SessionEventLike) => void,
    ): () => void

    // ---- waterfall events --------------------------------------------------
    on(
      event: 'agent/pre-step',
      listener: (
        payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
        next: () => Promise<PreStepDecision>,
      ) => Promise<PreStepDecision>,
      options?: { prepend?: boolean },
    ): () => void
    on(
      event: 'tools/post-execute',
      listener: (
        exec: ToolExecution,
        result: Readonly<ToolExecutionResult>,
        next: () => Promise<PostToolDecision>,
      ) => Promise<PostToolDecision>,
    ): () => void
    on(
      event: 'tools/pre-execute',
      listener: (
        exec: ToolExecution,
        next: () => Promise<PreToolDecision>,
      ) => Promise<PreToolDecision>,
      options?: { prepend?: boolean },
    ): () => void
    on(
      event: 'system-prompt/assemble',
      listener: (
        assembly: PromptAssembly,
        context: AssembleContext,
        next: () => Promise<PromptAssembly>,
      ) => Promise<PromptAssembly>,
    ): () => void

    // ---- catch-all (unknown host events) ------------------------------------
    on(event: string, listener: (...args: unknown[]) => unknown, options?: { prepend?: boolean }): () => void

    /**
     * Register a resource with an optional disposer, cleaned up on plugin
     * unload.
     */
    effect(callback: () => unknown | (() => void | Promise<void>)): void

    readonly logger: Logger
    readonly tools: ToolsService
    readonly systemPrompt: SystemPromptService
    /** Present in deployments that mount the settings provider. */
    readonly settings?: SettingsService
  }

  export type Events = Record<string, unknown>

  /** Service base class (class-form plugins). */
  export class Service {
    constructor(ctx: Context, name: string)
  }

  /**
   * Standard Schema v1 shape the loader uses to validate plugin `Config`
   * exports and fill defaults.
   */
  export interface StandardSchema<I = unknown, O = I> {
    readonly '~standard': {
      readonly version: 1
      readonly validate: (value: unknown) => O | { success: false; error: unknown }
      readonly types?: unknown
    }
  }
}

export {}
