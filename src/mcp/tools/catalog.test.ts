import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EFFECTS } from '../../engine/effects/registry';
import { CLIP_MOTIONS_IN } from '../../engine/clipAnim';
import { TRANSITIONS } from '../../engine/transitions/registry';
import { SHAPE_PRESETS } from '../../features/media/shapePresets';
import { TEXT_PRESETS } from '../../features/media/textPresets';
import { createCameraClip, createClipFromAsset, createEffectClip, createProject, createShapeClip, createTextClip } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import type { Clip, MediaAsset } from '../../types';
import { SHAPES_3D } from '../../types';
import { callTool } from '../registry';
import type { ToolResult } from '../types';
import { AUDIO_FIELDS, CAMERA_FIELDS, COMMON_FIELDS, EFFECT_FIELDS, PICTURE_FIELDS, SHAPE_FIELDS, TEXT_FIELDS, VIDEO_FIELDS, type FieldRow } from './catalogFields';

vi.mock('../../store/session', () => ({
  openProjectById: async () => true,
  createAndOpenProject: async () => ({}),
  closeProject: async () => {},
  flushAutosave: async () => {},
  importProjectFile: async () => 'x',
  useSaveState: { getState: () => ({ state: 'saved' }) },
}));
vi.mock('../../storage/db', () => ({ listProjects: async () => [] }));
vi.mock('../../media/importer', () => ({ importFiles: async () => [] }));

async function options(kind: string, category?: string) {
  const r = (await callTool('list_options', { kind, ...(category ? { category } : {}) })) as ToolResult;
  const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
  return { error: r.isError === true, text, json: r.isError ? null : (JSON.parse(text) as Record<string, any>) };
}

describe('list_options', () => {
  it('effects come from the registry, with params, and can be filtered', async () => {
    const all = await options('effects');
    expect(all.json!.effects).toHaveLength(EFFECTS.length);
    const first = EFFECTS[0]!;
    expect(all.json!.effects[0]).toMatchObject({ id: first.id, name: first.name, category: first.category });
    expect(all.json!.effects[0].params[0]).toMatchObject({ key: first.params[0]!.key, min: first.params[0]!.min, max: first.params[0]!.max, default: first.params[0]!.default });
    const withOptions = EFFECTS.flatMap((e) => e.params).find((p) => p.options);
    if (withOptions) expect(all.text).toContain(JSON.stringify(withOptions.options));
    const blur = await options('effects', 'blur');
    expect(blur.json!.effects.length).toBe(EFFECTS.filter((e) => e.category === 'blur').length);
    expect(blur.json!.effects.every((e: any) => e.category === 'blur')).toBe(true);
    expect(all.text).not.toContain('glsl');
  });

  it('transitions come from the registry', async () => {
    const all = await options('transitions');
    expect(all.json!.transitions).toHaveLength(TRANSITIONS.length);
    expect(all.json!.transitions[0]).toEqual({ id: TRANSITIONS[0]!.id, name: TRANSITIONS[0]!.name, category: TRANSITIONS[0]!.category });
    const wipes = await options('transitions', 'wipe');
    expect(wipes.json!.transitions.every((t: any) => t.category === 'wipe')).toBe(true);
    expect(all.json!.duration).toMatchObject({ min: 0.1, max: 5 });
  });

  it('refuses a category that does not belong', async () => {
    expect((await options('effects', 'wipe')).text).toMatch(/no effect category "wipe"/);
    expect((await options('transitions', 'blur')).text).toMatch(/no transition category "blur"/);
    expect((await options('fonts', 'blur')).text).toMatch(/only filters effects and transitions/);
    expect((await options('colors')).error).toBe(true);
    expect((await options('effects', 'nonsense')).error).toBe(true);
  });

  it('presets', async () => {
    const text = await options('text_presets');
    expect(text.json!.presets).toHaveLength(TEXT_PRESETS.length);
    expect(text.json!.presets[0]).toEqual({ id: TEXT_PRESETS[0]!.id, label: TEXT_PRESETS[0]!.label, hint: TEXT_PRESETS[0]!.hint });
    const shapes = await options('shape_presets');
    expect(shapes.json!.presets).toHaveLength(SHAPE_PRESETS.length);
    expect(shapes.json!.presets.some((p: any) => p.solid)).toBe(true);
  });

  it('shapes: 2d kinds, 3d shapes and the sides of each', async () => {
    const r = await options('shapes');
    expect(r.json!.kinds).toContain('star');
    expect(r.json!.shapes3d.map((s: any) => s.id)).toEqual(SHAPES_3D);
    expect(r.json!.shapes3d.find((s: any) => s.id === 'box').sides).toEqual(['front', 'back', 'right', 'left', 'top', 'bottom']);
    expect(r.json!.shapes3d.find((s: any) => s.id === 'plane').sides).toEqual([]);
  });

  it('motions', async () => {
    const r = await options('motions');
    expect(r.json!.clip.in).toHaveLength(CLIP_MOTIONS_IN.length);
    expect(r.json!.clip.in.find((m: any) => m.id === 'fly-in').threeD).toBe(true);
    expect(r.json!.text.loop.length).toBeGreaterThan(0);
    expect(r.json!.clip.defaultDuration.loop).toBeGreaterThan(0);
  });

  it('fonts: the bundled ones only', async () => {
    const r = await options('fonts');
    const families = r.json!.fonts.map((f: any) => f.family);
    expect(families).toContain('Inter');
    expect(r.json!.fonts.every((f: any) => !['system', 'local', 'imported'].includes(f.category))).toBe(true);
    expect(r.json!.note).toMatch(/family name/);
  });

  it('enums', async () => {
    const r = await options('enums');
    expect(r.json!.blendModes).toContain('screen');
    expect(r.json!.maskShapes).toContain('ellipse');
    expect(r.json!.easings.find((e: any) => e.id === 'ease').label).toBe('smooth');
    expect(r.json!.lookAt.map((l: any) => l.id)).toEqual(['none', 'camera', 'cameraY', 'clip']);
    expect(r.json!.faceFits.map((l: any) => l.id)).toEqual(['fill', 'fit', 'stretch']);
    expect(r.json!.canvasPresets[0]).toEqual({ id: '16:9', width: 1920, height: 1080 });
    expect(r.json!.fps).toContain(60);
    expect(r.json!.motionBlurStyles).toEqual(['even', 'trail', 'ghost']);
    expect(r.json!.textAlign.map((l: any) => l.id)).toEqual(['left', 'center', 'right']);
  });

  it('fields has every clip type and is compact', async () => {
    const r = await options('fields');
    for (const k of ['all', 'picture', 'video', 'audio', 'text', 'shape', 'effect', 'camera']) expect(r.json![k].length, k).toBeGreaterThan(0);
    expect(r.json!.picture.find((f: any) => f.field === 'transform').note).toMatch(/0\.01\.\.100/);
    expect(r.text.length).toBeLessThan(20000);
  });
});

/* every field named in the reference has to be one the store really keeps on that clip type */

function asset(kind: MediaAsset['kind']): MediaAsset {
  return { id: `ast_${kind}`, name: kind, kind, mime: '', size: 1, duration: kind === 'image' ? 0 : 10, width: 100, height: 100, hasAudio: true, createdAt: 0 };
}

function clipsOfEveryType(): Record<string, Clip> {
  const video = createProject();
  const track = video.tracks[0]!.id;
  return {
    video: createClipFromAsset(asset('video'), track, 0),
    image: createClipFromAsset(asset('image'), track, 0),
    audio: createClipFromAsset(asset('audio'), video.tracks[1]!.id, 0),
    text: createTextClip(track, 0),
    shape: createShapeClip(track, 0),
    effect: createEffectClip('shake', 'shake', track, 0),
    camera: createCameraClip(track, 0),
  };
}

const GROUPS: { rows: FieldRow[]; types: string[] }[] = [
  { rows: COMMON_FIELDS, types: ['video', 'image', 'audio', 'text', 'shape', 'effect', 'camera'] },
  { rows: PICTURE_FIELDS, types: ['video', 'image', 'text', 'shape'] },
  { rows: VIDEO_FIELDS, types: ['video'] },
  { rows: AUDIO_FIELDS, types: ['audio'] },
  { rows: TEXT_FIELDS, types: ['text'] },
  { rows: SHAPE_FIELDS, types: ['shape'] },
  { rows: EFFECT_FIELDS, types: ['effect'] },
  { rows: CAMERA_FIELDS, types: ['camera'] },
];

describe('the fields reference matches the store', () => {
  beforeEach(() => {
    useEditor.getState().closeProject();
  });

  it('every field exists on a clip of its type, or the store accepts it as an optional one', () => {
    const made = clipsOfEveryType();
    const project = createProject('fields');
    project.assets = [asset('video'), asset('image'), asset('audio')];
    project.clips = Object.values(made);
    useEditor.getState().openProject(project);
    for (const { rows, types } of GROUPS) {
      for (const row of rows) {
        for (const type of types) {
          const clip = made[type]!;
          const where = `${type}.${row.field}`;
          if (row.field in clip) continue;
          expect(row.example, `${where} is not on a fresh clip, it needs an example`).not.toBeUndefined();
          useEditor.getState().updateClip(clip.id, { [row.field]: row.example });
          const after = useEditor.getState().project!.clips.find((c) => c.id === clip.id)!;
          expect(row.field in after, `${where} was dropped by updateClip`).toBe(true);
          expect((after as unknown as Record<string, unknown>)[row.field], where).not.toBeUndefined();
        }
      }
    }
  });

  it('no field is listed twice for one clip type', () => {
    for (const type of ['video', 'image', 'audio', 'text', 'shape', 'effect', 'camera']) {
      const names = GROUPS.filter((g) => g.types.includes(type)).flatMap((g) => g.rows.map((r) => r.field));
      expect(new Set(names).size, type).toBe(names.length);
    }
  });

  it('the fields the tools take elsewhere are not listed as patch fields', () => {
    const all = GROUPS.flatMap((g) => g.rows.map((r) => r.field));
    for (const refused of ['id', 'type', 'trackId', 'start', 'duration', 'trimStart', 'keyframes', 'faces', 'effect']) {
      expect(all.includes(refused) ? 'listed' : 'absent', refused).toBe('absent');
    }
  });
});

describe('the fields reference states the ranges the store and update_clip enforce', () => {
  const row = (list: FieldRow[], field: string) => list.find((r) => r.field === field)!;
  it('writes speed, bpm and the mask size into the rows', () => {
    expect(row(VIDEO_FIELDS, 'speed').type).toContain('0.25..4');
    expect(row(AUDIO_FIELDS, 'bpm').type).toContain('20..400');
    expect(row(VIDEO_FIELDS, 'volume').type).toContain('0..2');
    expect(row(PICTURE_FIELDS, 'mask').note).toContain('height 0..3');
    expect(row(PICTURE_FIELDS, 'transform').note).toContain('opacity 0..1');
  });
});
