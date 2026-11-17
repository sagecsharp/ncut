import { describe, expect, it } from 'vitest';
import { DEFAULT_SCOPES, ensureKind, parseScopesPrefs, shownInOrder, toggleKindIn } from './scopesState';

describe('scopes prefs', () => {
  it('parse survives junk and puts kinds in drawing order', () => {
    expect(parseScopesPrefs(null)).toEqual(DEFAULT_SCOPES);
    expect(parseScopesPrefs('{nope')).toEqual(DEFAULT_SCOPES);
    expect(parseScopesPrefs(42)).toEqual(DEFAULT_SCOPES);
    const p = parseScopesPrefs(JSON.stringify({ open: true, kinds: ['histogram', 'nope', 'waveform', 'waveform'], exact: true, vectorZoom: 2, sideWidth: 9999, belowHeight: 'x' }));
    expect(p.open).toBe(true);
    expect(p.kinds).toEqual(['waveform', 'histogram']);
    expect(p.exact).toBe(true);
    expect(p.vectorZoom).toBe(2);
    expect(p.sideWidth).toBe(2000);
    expect(p.belowHeight).toBe(DEFAULT_SCOPES.belowHeight);
    // nothing known in the list: the default kinds
    expect(parseScopesPrefs({ kinds: ['x'] }).kinds).toEqual(['waveform', 'vectorscope']);
    expect(parseScopesPrefs({ vectorZoom: 3, sideWidth: 5 }).vectorZoom).toBe(1);
    expect(parseScopesPrefs({ sideWidth: 5 }).sideWidth).toBe(120);
  });
  it('toggleKindIn adds in order and keeps the last', () => {
    expect(toggleKindIn(['waveform'], 'histogram')).toEqual(['waveform', 'histogram']);
    expect(toggleKindIn(['histogram'], 'parade')).toEqual(['parade', 'histogram']);
    expect(toggleKindIn(['waveform', 'parade'], 'parade')).toEqual(['waveform']);
    expect(toggleKindIn(['waveform'], 'waveform')).toEqual(['waveform']);
  });
  it('ensureKind never hides', () => {
    expect(ensureKind(['waveform'], 'vectorscope')).toEqual(['waveform', 'vectorscope']);
    expect(ensureKind(['waveform', 'vectorscope'], 'vectorscope')).toEqual(['waveform', 'vectorscope']);
    expect(shownInOrder(['histogram', 'waveform'])).toEqual(['waveform', 'histogram']);
  });
});
