/**
 * Runtime stub of `@deepseek-ai/schemastery` for the vitest environment:
 * enough of the fluent API for the plugin's `Config` export to construct.
 * No validation semantics (the host loader owns those); the `~standard`
 * surface is a pass-through.
 *
 * ANTI-DRIFT RULE (2026-09-13 boot-crash incident): this mock must only
 * implement members of the REAL schemastery (v3.18.2). The host runs the real
 * package, so a member present here but absent there (the removed `enum`)
 * made tests pass while production crashed at plugin load.
 * `test/schemastery-api-guard.spec.ts` asserts this mock's static surface is
 * a subset of the real API.
 */
function node(type, meta = {}) {
  const self = {
    type,
    meta,
    default(value) {
      self.meta.default = value
      return self
    },
    required() { self.meta.required = true; return self },
    min(v) { self.meta.min = v; return self },
    max(v) { self.meta.max = v; return self },
    step(v) { self.meta.step = v; return self },
    pattern(v) { self.meta.pattern = v; return self },
    description(v) { self.meta.description = v; return self },
    comment(v) { self.meta.comment = v; return self },
    deprecated() { return self },
    experimental() { return self },
    toString() { return `Schema(${self.type})` },
    toJSON() { return self },
    get '~standard'() {
      return { version: 1, validate: (value) => value }
    },
  }
  return self
}

const Schema = {
  object(dict) {
    const self = node('object', { dict })
    return self
  },
  string: () => node('string'),
  number: () => node('number'),
  natural: () => node('number'),
  percent: () => node('number'),
  boolean: () => node('boolean'),
  never: () => node('never'),
  const: (value) => node('const', { value }),
  array(inner) {
    const self = node('array')
    self.inner = inner
    return self
  },
  union(list) {
    const self = node('union')
    self.list = list
    return self
  },
  tuple(list) {
    const self = node('tuple')
    self.list = list
    return self
  },
  intersect(list) {
    const self = node('intersect')
    self.list = list
    return self
  },
  date: () => node('date'),
  from: () => node('any'),
  extend() {},
  resolve: (data) => [data],
}

export default Schema
