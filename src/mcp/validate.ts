import type { JsonSchema } from './types';

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function fits(type: NonNullable<JsonSchema['type']>, v: unknown): boolean {
  switch (type) {
    case 'object':
      return typeOf(v) === 'object';
    case 'array':
      return Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
  }
}

/**
 * the first thing wrong with `value` under `schema`, as a sentence for the client, or null when it fits.
 * an object with `properties` takes no other keys unless additionalProperties is true (a typo in an
 * argument name should be an error, not a silent nothing). an object without `properties` is free form.
 */
export function validate(schema: JsonSchema, value: unknown, path = 'arguments'): string | null {
  if (schema.type && !fits(schema.type, value)) {
    return `${path} must be ${schema.type === 'object' || schema.type === 'array' || schema.type === 'integer' ? 'an' : 'a'} ${schema.type}, got ${typeOf(value)}`;
  }
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) {
    return `${path} must be one of: ${schema.enum.join(', ')}`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
  }
  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) {
    return `${path} is too long (at most ${schema.maxLength} characters)`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} takes at most ${schema.maxItems} items`;
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const bad = validate(schema.items, value[i], `${path}[${i}]`);
        if (bad) return bad;
      }
    }
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined) return `${path}.${key} is missing`;
    }
    if (schema.properties) {
      for (const key of Object.keys(obj)) {
        const sub = schema.properties[key];
        if (!sub) {
          if (schema.additionalProperties === true) continue;
          return `${path}.${key} is not a known field (known: ${Object.keys(schema.properties).join(', ') || 'none'})`;
        }
        if (obj[key] === undefined) continue;
        const bad = validate(sub, obj[key], `${path}.${key}`);
        if (bad) return bad;
      }
    }
  }
  return null;
}
