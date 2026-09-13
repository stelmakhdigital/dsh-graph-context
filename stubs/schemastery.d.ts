/**
 * Type stub for `@deepseek-ai/schemastery`, mirroring the public surface this
 * plugin uses: a class-shaped default export whose instances implement the
 * Standard Schema v1 interface consumed by the Cordis loader, plus the fluent
 * constraint methods. Only the API shape is modeled, not the resolver
 * semantics.
 *
 * ANTI-DRIFT RULE (2026-09-13 boot-crash incident): every member declared here
 * MUST exist in the REAL package (deepseek-harness `vendor/schemastery`
 * d.ts). The host process resolves the real schemastery at runtime, so an
 * invented member passes typecheck against this stub and crashes only at
 * plugin load (`z.enum` was exactly this — removed). Before adding a member,
 * verify it against the real d.ts; `test/schemastery-api-guard.spec.ts` keeps
 * the src call surface and the test mock inside the real API.
 */
declare module '@deepseek-ai/schemastery' {
  /** Standard Schema v1 props the Cordis loader invokes (`Config['~standard'].validate`). */
  interface StandardSchemaProps {
    readonly version: 1
    readonly validate: (value: unknown) => unknown
    readonly types?: unknown
  }

  class Schema<S = any, T = S> {
    static object<X extends Record<string, Schema>>(dict: X): Schema
    static string(): Schema<string, string>
    static number(): Schema<number, number>
    static natural(): Schema<number, number>
    static percent(): Schema<number, number>
    static boolean(): Schema<boolean, boolean>
    static never(): Schema<never, never>
    static const<T>(value: T): Schema<T, T>
    /** Accept arrays whose elements match `inner`. */
    static array<X>(inner: X): Schema
    static union<T>(list: readonly T[]): Schema
    static tuple<X extends readonly unknown[]>(list: X): Schema
    static intersect<T>(list: readonly T[]): Schema
    static date(): Schema<string | Date, Date>
    static from<X = any>(source?: X): Schema
    static extend(type: string, resolve: (data: unknown, schema: Schema, options?: unknown, strict?: boolean) => [unknown, unknown?]): void
    static resolve(data: unknown, schema: Schema, options?: unknown, strict?: boolean): [unknown, unknown?]
    readonly uid: number
    readonly type: string
    readonly '~standard': StandardSchemaProps
    readonly description?: string
    default(value: T): Schema<S, T>
    required(value?: boolean): Schema<S, T>
    min(value: number): Schema<S, T>
    max(value: number): Schema<S, T>
    step(value: number): Schema<S, T>
    pattern(regexp: RegExp): Schema<S, T>
    description(text: string): Schema<S, T>
    comment(text: string): Schema<S, T>
    deprecated(): Schema<S, T>
    experimental(): Schema<S, T>
    toString(inline?: boolean): string
    toJSON(): Schema<S, T>
  }

  /** Callable instance: validating a value yields the normalized output. */
  interface Schema<S = any, T = S> {
    (data?: S | null, options?: Record<string, unknown>): T
    new (data?: S | null, options?: Record<string, unknown>): T
  }

  export default Schema
}

export {}
