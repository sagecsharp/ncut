import { describe, expect, it } from 'vitest';
import { answerCall } from './dispatch';
import { callTool, listTools, TOOLS } from './registry';
import type { JsonSchema } from './types';

function checkSchema(schema: JsonSchema, where: string): void {
  if (schema.type === 'object' && schema.properties) {
    for (const key of schema.required ?? []) {
      if (!schema.properties[key]) throw new Error(`${where}: required "${key}" is not in properties`);
    }
    for (const [key, sub] of Object.entries(schema.properties)) checkSchema(sub, `${where}.${key}`);
  }
  if (schema.type === 'array' && schema.items) checkSchema(schema.items, `${where}[]`);
}

describe('the tool list', () => {
  it('has unique snake_case names, a title, a description and an object schema', () => {
    const seen = new Set<string>();
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(seen.has(t.name), `two tools named ${t.name}`).toBe(false);
      seen.add(t.name);
      expect(t.title.length, t.name).toBeGreaterThan(0);
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(() => checkSchema(t.inputSchema, t.name)).not.toThrow();
    }
  });

  it('lists what a client needs and nothing else', () => {
    const { tools } = listTools();
    expect(tools.length).toBe(TOOLS.length);
    for (const t of tools) {
      expect(Object.keys(t).sort().filter((k) => k !== 'annotations')).toEqual(['description', 'inputSchema', 'name', 'title']);
    }
    expect(() => JSON.stringify(tools)).not.toThrow();
  });

  it('an unknown tool is told apart from a failed one', async () => {
    expect(await callTool('no_such_tool', {})).toEqual({ unknown: true });
  });
});

describe('answerCall', () => {
  it('answers a list call with the tool list as json', async () => {
    const json = await answerCall({ id: 1, kind: 'list', name: '', args: {}, files: [], ticket: null });
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(listTools())));
  });

  it('answers an unknown tool', async () => {
    const json = await answerCall({ id: 2, kind: 'call', name: 'no_such_tool', args: {}, files: [], ticket: null });
    expect(JSON.parse(json)).toEqual({ unknown: true });
  });
});

describe('answerCall under a budget', () => {
  it('answers a tool that does not finish in time as failed, and a quick one as it is', async () => {
    const call = { id: 3, kind: 'call' as const, name: 'slow_tool', args: {}, files: [], ticket: null };
    const never = () => new Promise<never>(() => {});
    const slow = JSON.parse(await answerCall(call, 20, never));
    expect(slow.isError).toBe(true);
    expect(slow.content[0].text).toMatch(/slow_tool did not finish in time/);
    const quick = JSON.parse(await answerCall(call, 1000, async () => ({ content: [{ type: 'text', text: 'ok' }] })));
    expect(quick).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('a tool that throws is an error answer, not a crash', async () => {
    const call = { id: 4, kind: 'call' as const, name: 'bad_tool', args: {}, files: [], ticket: null };
    const out = JSON.parse(
      await answerCall(call, 1000, async () => {
        throw new Error('boom');
      }),
    );
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/boom/);
  });
});
