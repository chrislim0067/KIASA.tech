/**
 * Making a Zod-generated JSON Schema acceptable to strict structured output.
 *
 * WHY THIS IS NECESSARY, AND WHY IT IS NOT A WEAKENING
 *
 * OpenAI-compatible strict structured output accepts a deliberately small
 * subset of JSON Schema. Keywords outside it are not ignored — the request is
 * REJECTED with a 400. Zod's `toJSONSchema` faithfully emits everything the
 * schema expresses, and this project's résumé schema expresses a great deal:
 * measured on the real schema, 43 occurrences of unsupported keywords —
 * 21 `maxLength`, 12 `pattern`, 4 `maxItems`, 4 `minLength`, `minimum`,
 * `maximum` and `$schema`.
 *
 * Sent as-is, every real résumé import would fail at the provider. The build
 * passes, the types pass, the mocked tests pass, and the feature is broken the
 * first time a candidate uses it — which is exactly the kind of defect that
 * only appears in production.
 *
 * Stripping them loses nothing that mattered. The schema sent to a model is a
 * HINT about the shape to produce. The GUARANTEE is the Zod validation applied
 * to whatever comes back, which still enforces every length, pattern and bound
 * in full. A model that returns a 500-character job title still fails
 * validation; it simply fails on our side, where the rule actually lives,
 * instead of the request never being accepted at all.
 *
 * Structure is preserved exactly: types, properties, required, enums, nesting,
 * nullability and every `description` — the descriptions are the field-level
 * instructions, so they are the part that most earns its place in the request.
 */

/**
 * The keyword subset strict structured output accepts.
 * Everything else is removed.
 */
const SUPPORTED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'anyOf',
  'allOf',
  'oneOf',
  '$ref',
  '$defs',
  'definitions',
  'description',
  'const',
  'title',
]);

type JsonValue = unknown;

/**
 * Recursively remove unsupported keywords.
 *
 * `properties` and `$defs` are walked as MAPS OF SCHEMAS, not as schemas: a
 * résumé field legitimately named `pattern` or `title` must not be mistaken
 * for a JSON Schema keyword and deleted. Getting that wrong would silently
 * drop a field from the contract.
 */
export function toStrictJsonSchema(schema: JsonValue): JsonValue {
  if (Array.isArray(schema)) return schema.map(toStrictJsonSchema);
  if (schema === null || typeof schema !== 'object') return schema;

  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(schema as Record<string, JsonValue>)) {
    if (key === 'properties' || key === '$defs' || key === 'definitions') {
      const mapped: Record<string, JsonValue> = {};
      for (const [name, sub] of Object.entries((value ?? {}) as Record<string, JsonValue>)) {
        mapped[name] = toStrictJsonSchema(sub);
      }
      out[key] = mapped;
      continue;
    }
    if (!SUPPORTED_KEYWORDS.has(key)) continue;
    out[key] = toStrictJsonSchema(value);
  }
  return out;
}

/**
 * Every unsupported keyword still present, for tests and diagnostics.
 * Returns keyword paths, never any schema values.
 */
export function unsupportedKeywords(schema: JsonValue, path = '$'): string[] {
  const found: string[] = [];
  const walk = (node: JsonValue, at: string) => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${at}[${i}]`));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, JsonValue>)) {
      if (key === 'properties' || key === '$defs' || key === 'definitions') {
        for (const [name, sub] of Object.entries((value ?? {}) as Record<string, JsonValue>)) {
          walk(sub, `${at}.${key}.${name}`);
        }
        continue;
      }
      if (!SUPPORTED_KEYWORDS.has(key)) found.push(`${at}.${key}`);
      walk(value, `${at}.${key}`);
    }
  };
  walk(schema, path);
  return found;
}
