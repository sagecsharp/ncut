import { readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** every .tsx under src/features */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** the source without block comments and without // comments (a // after a colon is part of a url) */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const files = walk('src/features').map((file) => ({ file, src: strip(readFileSync(file, 'utf8')) }));

/** strings the word list may not keep: { file, text } pairs. see the word list in docs/FEATURES.md. empty at start. */
const ALLOW: { file: string; text: string }[] = [];

const BANNED = [
  /\bcut off the\b/,
  /\bassets?\b/,
  /\bsplit the group/,
  /\btake the sky off\b/,
  /\bsilence\b/,
  /\bfollow the tempo\b/,
  /3d, links/,
  /\bside view\b/,
  /\bshow the camera view\b/,
  /\bturn [xyz]\b/,
  /\bstop facing\b/,
  /\bface the camera\b/,
  /\bmaster volume\b/,
  /current time \/ total duration/,
  /\brepeat x2\b/,
  /\bkeys per second\b/,
  /\bjoints?\b/,
  /\bbones?\b/,
  /\banchors?\b/,
  /\bwarp/,
  /\bdeform/,
  /\broll(ing)? edit\b/,
  /\broll the edit\b/,
  /\bmonitor\b/,
  /\blinked\b/,
  /\bunlink/,
  /\bdetach (the )?(audio|sound)\b/,
  /\bsplit (the )?(audio|sound)\b/,
  /\bextract (the )?(audio|sound)\b/,
  /\bclip light\b/,
  /\bmaster (strip|fader|bus|meter)\b/,
  /\bire\b/,
  /\bcurve editor\b/,
  /\bfit to fill\b/,
];

/** the ui strings of one file: title, aria-label, placeholder and label values, the first string of tip( and does: */
function uiStrings(src: string): string[] {
  const out: string[] = [];
  const attr = /\b(?:title|aria-label|placeholder|label)=(?:"([^"]*)"|\{\s*'([^']*)'\s*\}|\{\s*`([^`]*)`\s*\})/g;
  const call = /\btip\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g;
  const does = /\bdoes:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g;
  for (const re of [attr, call, does]) {
    for (const m of src.matchAll(re)) out.push((m[1] ?? m[2] ?? m[3])!);
  }
  return out;
}

const allowed = (file: string, text: string): boolean => ALLOW.some((a) => a.file === file && a.text === text);

describe('word list', () => {
  it('ui strings keep to the word list', () => {
    const bad: string[] = [];
    for (const { file, src } of files) {
      for (const text of uiStrings(src)) {
        if (allowed(file, text)) continue;
        for (const re of BANNED) if (re.test(text.toLowerCase())) bad.push(`${file}: "${text}" matches ${re}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('visible text keeps to the word list', () => {
    const phrases = ['cut at the markers', 'face the camera', 'stop facing', 'no matching assets', "'turn x'", "'turn y'", "'turn z'"];
    const bad: string[] = [];
    for (const { file, src } of files) {
      for (const p of phrases) if (src.toLowerCase().includes(p) && !allowed(file, p)) bad.push(`${file}: ${p}`);
    }
    // jsx text runs between tags, like <button>joint</button>
    for (const { file, src } of files) {
      for (const m of src.matchAll(/>([^<>{}()=;]+)</g)) {
        const t = m[1].trim().toLowerCase();
        if (!t || allowed(file, m[1].trim())) continue;
        for (const re of BANNED) if (re.test(t)) bad.push(`${file}: "${t}" matches ${re}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('grade files say curves, never curve or graph', () => {
    const bad: string[] = [];
    for (const { file, src } of files) {
      const name = file.split('/').pop() ?? '';
      if (!name.startsWith('Grade') && !name.startsWith('MultiGrade')) continue;
      const texts = [...uiStrings(src), ...[...src.matchAll(/>([^<>{}()=;]+)</g)].map((m) => m[1].trim())];
      for (const text of texts) {
        if (/\bcurve\b/.test(text.toLowerCase()) || /\bgraph\b/.test(text.toLowerCase())) bad.push(`${file}: "${text}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('effect strength and motion blur shutter', () => {
    for (const name of ['EffectSection.tsx', 'MotionSection.tsx']) {
      const src = readFileSync(`src/features/properties/${name}`, 'utf8');
      expect(src, name).not.toContain('label="amount"');
    }
  });

  it('the allow list is empty', () => {
    expect(ALLOW).toEqual([]);
  });
});
