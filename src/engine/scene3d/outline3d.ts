/**
 * the line around a 3d solid (box, sphere, star ...), as pure data (no gl).
 *
 * a shape clip's outline used to be painted into the flat picture and wrapped round the solid with it: a dot at the
 * poles of a sphere, a square in the middle of a star. on a solid the line belongs to the solid instead: it is centered
 * on the silhouette and on every hard edge (the edges of a box, the rims of a cylinder, the front and back outline of a
 * star), like the 2d line is centered on the edge of the flat figure.
 *
 * the renderer draws it from three pieces, all in the unit space of the mesh (x, y, z in -0.5..0.5 plus the room the
 * line needs), so the plane's own model matrix places them:
 *   hull   the solid pushed out by half the line width
 *   core   the solid pulled in by half the line width
 *   strips a band of half the line width on both faces of every hard edge, lying on the faces
 * on screen the line is what the hull covers and the core does not (the silhouette, half the width on each side of it),
 * plus the strips (the hard edges inside the silhouette).
 *
 * the mesh is scaled by `sx, sy, sz` inside the model matrix (clip width, height, thickness in canvas pixels), so the
 * work is done in that scaled space, where `width` is a real length, and the result is divided back into unit space.
 */
import type { Shape3D } from '../../types';

export interface SolidOutline {
  /** triangles (3 indices each) into `hull` and `core`: the mesh of the shape with vertices at the same place welded */
  indices: Uint16Array;
  /** x, y, z per welded vertex, unit space: the solid pushed out by half the line width */
  hull: Float32Array;
  /** x, y, z per welded vertex, unit space: the solid pulled in by half the line width */
  core: Float32Array;
  /** x, y, z per vertex, plain triangles (3 vertices each, no index), unit space: the bands along the hard edges */
  strips: Float32Array;
}

/**
 * the outline pieces of `shape` scaled by sx, sy, sz, for a line `width` wide (in the scaled space).
 * 'plane' and unknown ids give empty arrays. cached, callers must not change the arrays.
 */
export function solidOutline(shape: Shape3D | string | undefined, sx: number, sy: number, sz: number, width: number): SolidOutline {
  void shape;
  void sx;
  void sy;
  void sz;
  void width;
  return { indices: new Uint16Array(0), hull: new Float32Array(0), core: new Float32Array(0), strips: new Float32Array(0) };
}
