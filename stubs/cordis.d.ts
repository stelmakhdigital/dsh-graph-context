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
  import type { Agent, PreStepDecision, SessionStartSource } from '@deepseek-ai/dsh-agent'
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
