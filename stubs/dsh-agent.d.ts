/**
 * Type stub for `@deepseek-ai/dsh-agent`: the live-agent handle plus the
 * pre-step decision the host's `agent/pre-step` waterfall returns. Mirrors the
 * runtime face the plugin touches: identity, session header (cwd), and the
 * model-facing input methods.
 */
declare module '@deepseek-ai/dsh-agent' {
  import type { UserMessage } from '@deepseek-ai/dsh-llm'

  /** Session-backed Agent identity (a branded string on the host). */
  export type SessionId = string

  /** Immutable validated storage metadata (host: SessionHeader). */
  export interface SessionHeader {
    readonly id: SessionId
    readonly createdAt: number
    /** Absolute working directory the session was created in, if any. */
    readonly cwd?: string
    /**
     * Subagent marker (P2b, verified 2026-09-14 against the host runtime):
     * set by the in-process driver's `childSessionMeta`
     * (packages/subagent/subagent/src/child-agent.ts) and carried by the
     * SessionHeader type (packages/session/session-format): durable across
     * persistence/resume.
     */
    readonly origin?: 'subagent'
    readonly parentSession?: SessionId
    readonly [key: string]: unknown
  }

  export interface Session {
    readonly header: SessionHeader
    readonly [key: string]: unknown
  }

  export type AgentStatus = 'idle' | 'running'

  /**
   * Public live-agent handle. The plugin reads `id` (state keying),
   * `session.header.cwd` (repo resolution), and calls `inject` to queue
   * model-facing context for the next request (never a wake-up).
   *
   * ANTI-DRIFT (verified 2026-09-14 against the host RUNTIME): `parentAgent`
   * exists in the public Agent d.ts but is NOT implemented on the concrete
   * agent (ReactLoopAgent exposes id/options/session/scope/ctx/inbox only) —
   * reading it always yields undefined. The reliable subagent marker is the
   * durable session-header field: `header.origin === 'subagent'` (fallback:
   * `header.parentSession`). See `isSubagentAgent` in src/hooks.ts.
   */
  export interface Agent {
    readonly id: SessionId
    readonly status: AgentStatus
    readonly session: Session
    /** The spawning agent for subagents; undefined for the session root agent. */
    readonly parentAgent?: Agent
    /** Queue model-facing context for the next pre-step without waking the driver. */
    inject(message: UserMessage): void
    /** Submit steering for the nearest step. */
    steer(message: UserMessage): void
    /** Queue an ordinary follow-up turn and wake the driver. */
    followup(message: UserMessage): void
  }

  /** Why a session lifecycle began. */
  export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'

  /** Whether and with which messages the loop enters a proposed step. */
  export type PreStepDecision =
    | { kind: 'reject' }
    | {
      kind: 'enter'
      messages: UserMessage[]
      /** Start a distinct model-message series before this step's admitted messages. */
      startsRequestSeries?: true
    }
}

export {}
