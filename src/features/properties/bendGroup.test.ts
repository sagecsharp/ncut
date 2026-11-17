import { describe, expect, it } from 'vitest';
import { createProject, createShapeClip } from '../../lib/factory';
import type { Keyframe, Project, ShapeClip, Transform, VisualClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { bendMembers, bendState, fitBend, keysFor } from './bendGroup';

let seq = 0;
function card(over: Partial<ShapeClip> & { tf?: Partial<Transform> } = {}): ShapeClip {
  const { tf, ...rest } = over;
  return createShapeClip('v', 0, { id: `bg${++seq}`, width: 100, height: 100, duration: 4, ...rest, transform: { ...DEFAULT_TRANSFORM, ...tf } });
}

function projectOf(clips: VisualClip[]): Project {
  return { ...createProject('bend'), clips };
}

/** five cards of 100 with a gap of 100: the row is 900 wide and its middle is x 0 */
const row = () => [-400, -200, 0, 200, 400].map((x) => card({ tf: { x } }));

describe('fitBend', () => {
  it('fitBend: five cards in a row get center -x / W and span W', () => {
    const clips = row();
    const members = bendMembers(projectOf(clips), clips, 0);
    const fit = fitBend(members, 'width')!;
    expect(fit.length).toBeCloseTo(900);
    expect(fit.onePlane).toBe(true);
    [-400, -200, 0, 200, 400].forEach((x, i) => {
      const f = fit.per.get(clips[i]!.id)!;
      expect(f.along).toBe('width');
      expect(f.span).toBeCloseTo(900);
      expect(f.center).toBeCloseTo(-x / 900);
    });
  });

  it('fitBend: a member turned 90 degrees bends along its height', () => {
    const clips = [card({ tf: { x: -200 } }), card({ tf: { x: 200, rotation: 90 } })];
    const members = bendMembers(projectOf(clips), clips, 0);
    const fit = fitBend(members, 'width')!;
    const turned = fit.per.get(clips[1]!.id)!;
    expect(turned.along).toBe('height');
    // the row is 500 wide, its middle at 0: the turned card's own y points to -x, so the sign flips
    expect(fit.length).toBeCloseTo(500);
    expect(turned.center).toBeCloseTo((0 - 200) * -1 / 500);
    expect(fit.onePlane).toBe(true);
  });

  it('fitBend: middle -0.5 puts the flat line at the first card', () => {
    const clips = row();
    const members = bendMembers(projectOf(clips), clips, 0);
    const fit = fitBend(members, 'width', -0.5)!;
    // the flat line is the left end of the row (x -450): the left edge of the first card
    expect(fit.per.get(clips[0]!.id)!.center).toBeCloseTo((-450 + 400) / 900);
    expect(fit.per.get(clips[4]!.id)!.center).toBeCloseTo((-450 - 400) / 900);
  });

  it('fitBend: onePlane is false for a card turned away or set back in z', () => {
    const three = (over: Partial<Transform>, x: number) => card({ threeD: true, tf: { x, ...over } });
    const flat = [three({}, -100), three({}, 100)];
    expect(fitBend(bendMembers(projectOf(flat), flat, 0), 'width')!.onePlane).toBe(true);
    const away = [three({}, -100), three({ rotY: 180 }, 100)];
    expect(fitBend(bendMembers(projectOf(away), away, 0), 'width')!.onePlane).toBe(false);
    const back = [three({}, -100), three({ z: 100 }, 100)];
    expect(fitBend(bendMembers(projectOf(back), back, 0), 'width')!.onePlane).toBe(false);
  });

  it('fitBend: a member under a scaled parent gets span W / k', () => {
    const parent = card({ tf: { scale: 2 } });
    const kid = card({ parent: parent.id, tf: {} });
    const project = projectOf([parent, kid]);
    const members = bendMembers(project, [kid], 0);
    expect(members[0]!.k).toBeCloseTo(2);
    expect(members[0]!.ownW).toBeCloseTo(200);
    const fit = fitBend(members, 'width')!;
    expect(fit.length).toBeCloseTo(200);
    expect(fit.per.get(kid.id)!.span).toBeCloseTo(100);
    expect(fit.per.get(kid.id)!.center).toBeCloseTo(0);
  });
});

describe('bendState', () => {
  it('bendState: together after a fit, off after a member moves', () => {
    const clips = row();
    const members = bendMembers(projectOf(clips), clips, 0);
    const fit = fitBend(members, 'width')!;
    const bent = clips.map((c) => ({ ...c, bend: { angle: 90, ...fit.per.get(c.id)! } }) as VisualClip);
    const together = bendState(members, bent);
    expect(together.together).toBe(true);
    expect(together.off).toEqual([]);
    expect(together.onePlane).toBe(true);
    expect(together.middle).toBeCloseTo(0);
    expect(together.keysApart).toBe(false);
    // one card moves: it no longer lies on the tube
    const moved = bent.map((c, i) => (i === 3 ? ({ ...c, transform: { ...c.transform, x: c.transform.x + 40 } } as VisualClip) : c));
    const after = bendState(bendMembers(projectOf(moved), moved, 0), moved);
    expect(after.together).toBe(false);
    expect(after.off).toEqual([moved[3]!.id]);
    // a clip with no bend at all is not together
    expect(bendState(members, clips).together).toBe(false);
  });
});

describe('keysFor', () => {
  it('keysFor shifts the leader keys to the member start', () => {
    const keys: Keyframe[] = [
      { t: 0, v: 0, ease: 'linear' },
      { t: 1, v: 90, ease: 'ease' },
    ];
    const out = keysFor(keys, 2, 3);
    expect(out.map((k) => k.t)).toEqual([-1, 0]);
    expect(out.map((k) => k.v)).toEqual([0, 90]);
    expect(out[1]!.ease).toBe('ease');
    expect(keysFor(keys, 2, 1).map((k) => k.t)).toEqual([1, 2]);
  });
});
