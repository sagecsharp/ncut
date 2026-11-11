import { describe, expect, it } from 'vitest';
import type { JsonSchema } from './types';
import { validate } from './validate';

const schema: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 8 },
    time: { type: 'number', minimum: 0 },
    count: { type: 'integer', minimum: 1, maximum: 4 },
    on: { type: 'boolean' },
    edge: { type: 'string', enum: ['start', 'end'] },
    ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
    patch: { type: 'object' },
    strict: { type: 'object', properties: { a: { type: 'number' } } },
    loose: { type: 'object', properties: { a: { type: 'number' } }, additionalProperties: true },
  },
  required: ['id'],
};

describe('validate', () => {
  it('takes what fits', () => {
    expect(validate(schema, { id: 'c1' })).toBeNull();
    expect(
      validate(schema, { id: 'c1', time: 0, count: 4, on: false, edge: 'end', ids: ['a'], patch: { anything: [1, { b: 2 }] }, strict: { a: 1 }, loose: { a: 1, z: 'x' } }),
    ).toBeNull();
  });

  it('names the argument and the problem', () => {
    expect(validate(schema, {})).toBe('arguments.id is missing');
    expect(validate(schema, { id: 5 })).toBe('arguments.id must be a string, got number');
    expect(validate(schema, { id: 'c1', time: -1 })).toBe('arguments.time must be at least 0');
    expect(validate(schema, { id: 'c1', count: 5 })).toBe('arguments.count must be at most 4');
    expect(validate(schema, { id: 'c1', count: 1.5 })).toBe('arguments.count must be an integer, got number');
    expect(validate(schema, { id: 'c1', edge: 'middle' })).toBe('arguments.edge must be one of: start, end');
    expect(validate(schema, { id: 'c1', ids: [] })).toBe('arguments.ids needs at least 1 item');
    expect(validate(schema, { id: 'c1', ids: ['a', 'b', 'c', 'd'] })).toBe('arguments.ids takes at most 3 items');
    expect(validate(schema, { id: 'c1', ids: ['a', 2] })).toBe('arguments.ids[1] must be a string, got number');
    expect(validate(schema, { id: '123456789' })).toBe('arguments.id is too long (at most 8 characters)');
    expect(validate(schema, { id: 'c1', strict: { a: 'x' } })).toBe('arguments.strict.a must be a number, got string');
  });

  it('a number has to be a real one', () => {
    expect(validate(schema, { id: 'c1', time: Number.NaN })).toBe('arguments.time must be a number, got number');
    expect(validate(schema, { id: 'c1', time: Number.POSITIVE_INFINITY })).toBe('arguments.time must be a number, got number');
    expect(validate(schema, { id: 'c1', time: '3' })).toBe('arguments.time must be a number, got string');
  });

  it('null and arrays are not objects', () => {
    expect(validate(schema, null)).toBe('arguments must be an object, got null');
    expect(validate(schema, [])).toBe('arguments must be an object, got array');
    expect(validate(schema, { id: 'c1', patch: [] })).toBe('arguments.patch must be an object, got array');
  });

  it('a typo in a field name is an error, unless the object is open', () => {
    expect(validate(schema, { id: 'c1', tiem: 3 })).toMatch(/^arguments\.tiem is not a known field \(known: id, time, /);
    expect(validate(schema, { id: 'c1', strict: { b: 1 } })).toBe('arguments.strict.b is not a known field (known: a)');
    expect(validate(schema, { id: 'c1', loose: { b: 1 } })).toBeNull();
  });

  it('an undefined value counts as left out', () => {
    expect(validate(schema, { id: 'c1', time: undefined })).toBeNull();
  });
});
