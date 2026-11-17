import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHORTCUTS } from './shortcuts';
import { ariaKeys, capsOf, capsText, tip } from './tip';

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const files = sources('src/features').map((p) => ({ p, text: readFileSync(p, 'utf8') }));

describe('tip', () => {
  it('split gives its caps and aria keys', () => {
    const a = tip('split', { keys: 'split' });
    expect(a['data-tip-keys']).toBe('[["s"],["ctrl","b"]]');
    expect(a['aria-keyshortcuts']).toBe('S Control+B');
  });

  it('pick keeps one alternative, several ids join in order', () => {
    expect(capsOf('split', 1)).toEqual([['ctrl', 'b']]);
    expect(capsOf('split', 0)).toEqual([['s']]);
    const both = capsOf(['split', 'undo']);
    expect(both.slice(0, 2)).toEqual([['s'], ['ctrl', 'b']]);
    expect(both.length).toBeGreaterThan(2);
  });

  it('an unknown id throws in dev', () => {
    expect(() => capsOf('no-such-row')).toThrow('tip: no shortcut "no-such-row"');
    expect(() => tip('x', { keys: 'no-such-row' })).toThrow();
  });

  it('tip always writes an empty title and leaves out what is not set', () => {
    expect(tip('undo')).toEqual({ title: '', 'data-tip': 'undo' });
    const a = tip('undo', { off: false, side: 'bottom' });
    expect('data-tip-off' in a).toBe(false);
    expect('data-tip-side' in a).toBe(false);
    expect('data-tip-off' in tip('undo', { off: null })).toBe(false);
    const b = tip('snap', { does: 'x', off: 'turn it on', why: 'split', on: false, side: 'top' });
    expect(b).toMatchObject({ title: '', 'data-tip-does': 'x', 'data-tip-off': 'turn it on', 'data-tip-why': 'split', 'data-tip-on': 'false', 'data-tip-side': 'top' });
  });

  it('ariaKeys maps named keys and drops mouse words', () => {
    expect(ariaKeys([['shift', 'f10']])).toBe('Shift+F10');
    expect(ariaKeys([['menu']])).toBe('ContextMenu');
    expect(ariaKeys([['+']])).toBe('Plus');
    expect(ariaKeys([['←']])).toBe('ArrowLeft');
    expect(ariaKeys([['drag']])).toBe('');
    expect(ariaKeys([['num 1']])).toBe('');
    expect(ariaKeys([['drag'], ['s']])).toBe('S');
  });

  it('capsText joins caps with + and alternatives with a comma', () => {
    expect(capsText([['s'], ['ctrl', 'b']])).toBe('s, ctrl+b');
    expect(capsText([])).toBe('');
  });

  it('every key id used in the source is a table row', () => {
    const rows = new Set(SHORTCUTS.map((s) => s.id));
    const used: { p: string; id: string }[] = [];
    for (const { p, text } of files) {
      for (const m of text.matchAll(/keys:\s*'([^']+)'/g)) used.push({ p, id: m[1]! });
      for (const m of text.matchAll(/keys:\s*\[(?!\[)([^\]]*)\]/g)) {
        for (const q of m[1]!.matchAll(/'([^']+)'/g)) used.push({ p, id: q[1]! });
      }
      for (const m of text.matchAll(/<MenuKeys\s+id="([^"]+)"/g)) used.push({ p, id: m[1]! });
    }
    const missing = used.filter((u) => !rows.has(u.id)).map((u) => `${u.p}: ${u.id}`);
    expect(missing).toEqual([]);
  });

  it('no element has both tip() and a title', () => {
    const bad: string[] = [];
    for (const { p, text } of files) {
      // one opening tag at a time, from < to the > that is not part of =>, <= or >=
      for (const m of text.matchAll(/<[A-Za-z](?:[^<>]|=>|<=|>=)*?\{\.\.\.tip\((?:[^<>]|=>|<=|>=)*?(?<!=)>(?!=)/g)) {
        const tag = m[0].replace(/\{\.\.\.tip\([^}]*\)\}/g, '');
        if (/\stitle=/.test(tag)) bad.push(`${p}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
