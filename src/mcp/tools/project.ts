/** project and view tools (docs/MCP.md): what is open, making and opening projects, tracks, markers, undo, the playhead */
import { animProps } from '../../lib/anim';
import { busyReason } from '../../lib/busy';
import { CANVAS_PRESETS, MAX_FPS } from '../../lib/factory';
import { shell } from '../../lib/shell';
import { defaultFog, FOG_GAP, FOG_MAX } from '../../features/properties/fogLogic';
import { defaultLight, sameLight, sceneTime, setSunHeight, setSunPercent, setSunTurn } from '../../features/properties/lightLogic';
import { autoLightAt, skyLightOf } from '../../engine/scene3d/light';
import { layoutOf, skyBlur, skyBrightness, skyTurn, skyTurnsOf, skyUsable, withSkyValues } from '../../engine/scene3d/sky';
import { SkyError, skyFromAssets, skyFromFaces } from '../../media/skyImport';
import { keepOf } from '../../features/properties/skyLogic';
import { projectDuration } from '../../lib/timelineOps';
import { faceNames } from '../../engine/scene3d/faces';
import { getEffect } from '../../engine/effects/registry';
import { listProjects } from '../../storage/db';
import { useEditor } from '../../store/editorStore';
import type { ProjectSettingsPatch } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { closeProject, createAndOpenProject, deleteStoredProject, openProjectById, useSaveState } from '../../store/session';
import { useUi } from '../../store/ui';
import type { Project, SceneFog, SceneLight, SceneSky } from '../../types';
import { changedSince, clipBrief, needClip, needProject, needTrack, ok, oneStep, optNumber, optString, round, ToolError } from '../helpers';
import type { ToolDef } from '../types';

const MAX_UNDO_STEPS = 50;
const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** the project in a few numbers, no clips and no media rows */
function projectBrief(p: Project): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    width: p.width,
    height: p.height,
    fps: p.fps,
    duration: round(projectDuration(p)),
    background: p.background,
    tracks: p.tracks.length,
    clips: p.clips.length,
    media: p.assets.length,
    markers: p.markers?.length ?? 0,
  };
}

/** the fog as the answers show it: the object, or null when there is none */
function fogOf(p: Project): SceneFog | null {
  return p.fog ? { color: p.fog.color, near: p.fog.near, far: p.fog.far, amount: p.fog.amount } : null;
}

/** the light as the answers show it: the object, or null when the scene gives it */
function lightOf(p: Project): SceneLight | null {
  const l = p.light;
  return l ? { sky: l.sky, horizon: l.horizon, ground: l.ground, sun: l.sun, sunColor: l.sunColor, sunTurn: l.sunTurn, sunHeight: l.sunHeight } : null;
}

/** the sky as the answers show it: the object, or null when there is none (missing: true when its pictures are gone) */
function skyOf(p: Project): Record<string, unknown> | null {
  const s = p.sky;
  if (!s) return null;
  const out: Record<string, unknown> = {};
  if (typeof s.asset === 'string' && s.asset) {
    out.asset = s.asset;
    const a = p.assets.find((x) => x.id === s.asset);
    const layout = a ? layoutOf(a.width, a.height) : null;
    if (layout) out.layout = layout;
  } else {
    out.faces = s.faces;
    out.turns = skyTurnsOf(s);
  }
  out.turn = skyTurn(s);
  out.brightness = skyBrightness(s);
  out.blur = skyBlur(s);
  out.light = { ...s.light };
  if (!skyUsable(p)) out.missing = true;
  return out;
}

/** an export in progress would break when the project under it changes */
function refuseWhileBusy(what: string): void {
  const busy = busyReason();
  if (busy) throw new ToolError(`cannot ${what} while ${busy}. wait for it (export_status) or stop it (export_cancel)`);
}

function cleanName(v: unknown, what: string): string | undefined {
  const name = optString(v);
  if (name === undefined) return undefined;
  const clean = name.trim();
  if (!clean) throw new ToolError(`${what} cannot be empty`);
  return clean;
}

/**
 * checks args.fog and puts the new fog on the patch. a default fog comes from the background and height after this call (they are on the patch already). returns true when it is the fog the project has already
 * (the store compares objects by identity and would write a step for it)
 */
function layFog(p: Project, v: unknown, patch: { fog?: SceneFog | null; background?: string; height?: number }): boolean {
  if (v === null) {
    if (!p.fog) return true;
    patch.fog = null;
    return false;
  }
  // the schema has no type for fog (null must pass), so the shape is checked here
  if (typeof v !== 'object' || Array.isArray(v)) throw new ToolError('fog must be an object like { color, near, far, amount } or null');
  const given = v as Record<string, unknown>;
  const next: SceneFog = { ...(p.fog ?? defaultFog(patch.background ?? p.background, patch.height ?? p.height, skyLightOf(p)?.horizon)) };
  if (typeof given.color === 'string') {
    if (!COLOR.test(given.color)) throw new ToolError('fog.color must be a hex color like #101010');
    next.color = given.color.toLowerCase();
  }
  // whole pixels like the inspector
  if (typeof given.near === 'number') next.near = Math.round(given.near);
  if (typeof given.far === 'number') next.far = Math.round(given.far);
  if (typeof given.amount === 'number') next.amount = Number(given.amount.toFixed(4));
  if (next.far < next.near + FOG_GAP) throw new ToolError(`fog.far (${next.far}) must be at least ${FOG_GAP} past fog.near (${next.near})`);
  if (p.fog && p.fog.color === next.color && p.fog.near === next.near && p.fog.far === next.far && p.fog.amount === next.amount) return true;
  patch.fog = next;
  return false;
}

/**
 * checks args.light and puts the new light on the patch. a part is laid over the own light, or over the one the scene gives at the playhead, with the background and fog of this call already in it. returns true when it is the light the project has already
 * (the store compares objects by identity and would write a step for it)
 */
function layLight(p: Project, v: unknown, patch: ProjectSettingsPatch, time: number): boolean {
  if (v === null) {
    if (!p.light) return true;
    patch.light = null;
    return false;
  }
  // the schema has no type for light (null must pass), so the shape is checked here
  if (typeof v !== 'object' || Array.isArray(v)) throw new ToolError('light must be an object like { sky, horizon, ground, sun, sunColor, sunTurn, sunHeight } or null');
  const given = v as Record<string, unknown>;
  let next: SceneLight = { ...(p.light ?? defaultLight({ ...p, ...patch } as Project, time)) };
  for (const key of ['sky', 'horizon', 'ground', 'sunColor'] as const) {
    const c = given[key];
    if (typeof c !== 'string') continue;
    if (!COLOR.test(c)) throw new ToolError(`light.${key} must be a hex color like #101010`);
    next[key] = c.toLowerCase();
  }
  if (typeof given.sun === 'number') next = setSunPercent(next, given.sun * 100);
  if (typeof given.sunTurn === 'number') next = setSunTurn(next, given.sunTurn);
  if (typeof given.sunHeight === 'number') next = setSunHeight(next, given.sunHeight);
  // the keys in the order of the answer
  next = lightOf({ ...p, light: next })!;
  if (p.light && sameLight(p.light, next)) return true;
  patch.light = next;
  return false;
}

/**
 * checks args.sky and puts the new sky on the patch. media or faces make a new one (turn, brightness and blur stay from
 * the sky the project has unless sent), turn, brightness or blur alone change the sky the project has. returns whether
 * it is the sky the project has already, and what the seam check changed
 */
async function laySky(p: Project, v: unknown, patch: ProjectSettingsPatch): Promise<{ same: boolean; notes: string[] }> {
  if (v === null) {
    if (!p.sky) return { same: true, notes: [] };
    patch.sky = null;
    return { same: false, notes: [] };
  }
  // the schema has no type for sky (null must pass), so the shape is checked here
  if (typeof v !== 'object' || Array.isArray(v)) throw new ToolError('sky must be an object like { media, turn, brightness, blur } or null');
  const given = v as Record<string, unknown>;
  if (given.light !== undefined) throw new ToolError('the light of a sky is measured from its pictures and cannot be sent. send light for an own light instead');
  if (given.media !== undefined && given.faces !== undefined) throw new ToolError('send sky.media or sky.faces, not both');
  if (given.turns !== undefined && given.faces === undefined) throw new ToolError('sky.turns goes with sky.faces');
  const values: { turn?: number; brightness?: number; blur?: number } = {};
  if (typeof given.turn === 'number') values.turn = given.turn;
  if (typeof given.brightness === 'number') values.brightness = given.brightness;
  if (typeof given.blur === 'number') values.blur = given.blur;
  const keep = { ...keepOf(p.sky), ...values };
  const list = (x: unknown, what: string): string[] => {
    if (!Array.isArray(x) || !x.every((i) => typeof i === 'string')) throw new ToolError(`sky.${what} must be a list of media ids`);
    return x as string[];
  };
  try {
    if (given.media !== undefined) {
      const made = await skyFromAssets(list(given.media, 'media'), keep);
      patch.sky = withSkyValues(made.sky, { ...keepOf(useEditor.getState().project?.sky), ...values });
      return { same: false, notes: made.notes };
    }
    if (given.faces !== undefined) {
      const turns = Array.isArray(given.turns) ? (given.turns as number[]) : [0, 0, 0, 0, 0, 0];
      const made = await skyFromFaces(list(given.faces, 'faces'), turns, keep);
      patch.sky = withSkyValues(made.sky, { ...keepOf(useEditor.getState().project?.sky), ...values });
      return { same: false, notes: made.notes };
    }
  } catch (e) {
    if (e instanceof SkyError) throw new ToolError(e.message);
    throw e;
  }
  if (!p.sky) throw new ToolError('the project has no sky. send sky.media (1 picture or 6) to make one');
  const next: SceneSky = withSkyValues(p.sky, values);
  if (next === p.sky) return { same: true, notes: [] };
  patch.sky = next;
  return { same: false, notes: [] };
}

export const projectTools: ToolDef[] = [
  {
    name: 'get_state',
    title: 'get the editor state',
    description:
      'a small snapshot of ncut: the app version, the open project (id, name, size, fps, duration, counts) or null, the playhead time in seconds, ' +
      'the selected clip ids, the save state, whether an export or another long job runs, and how many undo and redo steps there are. ' +
      'call it first to see whether a project is open. it holds no clips: get_project lists those.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run() {
      const s = useEditor.getState();
      const busy = busyReason();
      return ok({
        app: shell.version || 'browser',
        project: s.project ? projectBrief(s.project) : null,
        time: round(usePlayback.getState().time),
        playing: usePlayback.getState().playing,
        selection: s.selection,
        save: useSaveState.getState().state,
        exporting: busy !== null,
        busy,
        undoSteps: s.past.length,
        redoSteps: s.future.length,
      });
    },
  },
  {
    name: 'list_projects',
    title: 'list stored projects',
    description:
      'the projects stored in this app, newest first: id, name, size, fps, duration in seconds, clip count, last change as a unix time in milliseconds, ' +
      'and whether it is the open one. use open_project with an id to work in one, create_project to make a new one.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async run() {
      const openId = useEditor.getState().project?.id ?? null;
      const list = await listProjects();
      return ok({
        projects: list.map((p) => ({
          id: p.id,
          name: p.name,
          width: p.width,
          height: p.height,
          fps: p.fps,
          duration: round(p.duration),
          clips: p.clipCount,
          updated: p.updatedAt,
          open: p.id === openId,
        })),
      });
    },
  },
  {
    name: 'open_project',
    title: 'open a project',
    description:
      'opens a stored project in the editor window (the open one is saved first). undo history starts empty. the id of the project that is already open changes nothing: it answers the summary with a note. ' +
      'ids come from list_projects. refused while an export runs. answers a short summary of the project; get_project has the contents.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'project id from list_projects' } },
      required: ['id'],
    },
    annotations: { idempotentHint: true },
    async run(args) {
      refuseWhileBusy('open another project');
      const id = String(args.id);
      // reopening the open project would throw its undo history away for nothing
      const open = useEditor.getState().project;
      if (open && open.id === id) return ok({ ...projectBrief(open), note: 'this project is already open, so nothing was reopened and the undo history stays' });
      if (!(await openProjectById(id))) throw new ToolError(`no stored project with the id ${id}. list_projects lists them`);
      return ok(projectBrief(needProject()));
    },
  },
  {
    name: 'create_project',
    title: 'create and open a project',
    description:
      'makes a new empty project (one video track, one audio track) and opens it. the open project is saved first. ' +
      'preset picks the canvas ratio (default 16:9 = 1920x1080); width and height (pixels, 16..7680) and fps override it. ' +
      'answers the final size, so check it. undo history starts empty.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 200, description: 'project name, default "untitled project"' },
        preset: { type: 'string', enum: CANVAS_PRESETS.map((p) => p.id), description: 'canvas ratio, default 16:9' },
        width: { type: 'integer', minimum: 16, maximum: 7680, description: 'canvas width in pixels, replaces the preset width' },
        height: { type: 'integer', minimum: 16, maximum: 7680, description: 'canvas height in pixels, replaces the preset height' },
        fps: { type: 'number', minimum: 1, maximum: MAX_FPS, description: 'frames per second, default 30' },
      },
    },
    async run(args) {
      refuseWhileBusy('create a project');
      const name = cleanName(args.name, 'name');
      const preset = CANVAS_PRESETS.find((p) => p.id === args.preset);
      const made = await createAndOpenProject(name, preset, optNumber(args.fps));
      let open = useEditor.getState().project;
      if (!open || open.id !== made.id) throw new ToolError('the project was made but could not be opened');
      const width = optNumber(args.width);
      const height = optNumber(args.height);
      if (width !== undefined || height !== undefined) {
        // no undo step: a new project starts with an empty history
        useEditor.getState().updateProject({ ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) }, { skipHistory: true });
        open = needProject();
      }
      return ok(projectBrief(open));
    },
  },
  {
    name: 'close_project',
    title: 'close the project',
    description: 'saves the open project and goes back to the projects screen. nothing is lost. after it, tools that need a project fail until open_project or create_project. refused while an export runs.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const p = needProject();
      refuseWhileBusy('close the project');
      await closeProject();
      return ok({ closed: p.id });
    },
  },
  {
    name: 'delete_project',
    title: 'delete a project',
    description:
      'deletes a stored project with all of its media for good. there is no undo and no trash. send its id and its exact name from list_projects, plus updated from list_projects when another project has the same name (so a wrong id cannot delete the wrong project). ' +
      'when it is the open project, it is closed first, after that tools that need a project fail until open_project or create_project (another open project stays open). refused while an export runs.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'project id from list_projects' },
        name: { type: 'string', description: 'the exact name of that project, from list_projects' },
        updated: { type: 'number', description: 'its last change time (updated) from list_projects. needed when another project has the same name' },
      },
      required: ['id', 'name'],
    },
    annotations: { destructiveHint: true },
    async run(args) {
      refuseWhileBusy('delete a project');
      const id = String(args.id);
      const given = String(args.name).trim();
      const list = await listProjects();
      const found = list.find((p) => p.id === id);
      if (!found) throw new ToolError(`no project with the id ${id}. list_projects lists the projects`);
      if (found.name.trim() !== given) {
        const meant = list.filter((p) => p.name.trim() === given).map((p) => p.id);
        throw new ToolError(
          `nothing was deleted: the id ${id} and the name "${given}" are not the same project` +
            (meant.length ? `. the ${meant.length > 1 ? 'projects' : 'project'} called "${given}" ${meant.length > 1 ? 'have the ids' : 'has the id'} ${meant.join(', ')}` : '. no stored project has that name') +
            '. check list_projects for the project the user means',
        );
      }
      const twins = list.filter((p) => p.id !== id && p.name.trim() === given).length;
      if ((twins > 0 || args.updated !== undefined) && args.updated !== found.updatedAt) {
        throw new ToolError(
          args.updated === undefined
            ? `${twins + 1} projects are called "${given}". send updated (its last change time from list_projects) too, so the right one is deleted`
            : `nothing was deleted: updated (${String(args.updated)}) is not the last change time of the project ${id}. it changed since you listed it: call list_projects again and check it is still the project the user means`,
        );
      }
      // an export can start from the ui while the list was read: check again before the project is closed under it
      refuseWhileBusy('delete a project');
      const wasOpen = useEditor.getState().project?.id === id;
      try {
        await deleteStoredProject(id);
      } catch (e) {
        const why = e instanceof Error ? e.message : '';
        throw new ToolError(`could not delete the project ${id}${why ? `: ${why}` : ''}. list_projects shows what is still stored`);
      } finally {
        // a delete that failed halfway can still have changed the list
        useUi.getState().projectsChanged();
      }
      return ok({ deleted: id, name: found.name, wasOpen });
    },
  },
  {
    name: 'update_project',
    title: 'change project settings',
    description:
      'changes the name, canvas size (pixels, 16..7680), frame rate (1..240), background color (hex like #101010), fog, light or sky of the open project, as one undo step. ' +
      'clips keep their pixel positions when the canvas size changes. ' +
      'fog is haze over the 3d space: 3d clips blend toward its color the farther they are from the camera. near and far are distances from the camera in project pixels (far at least 10 past near), amount 0..1 is the strongest haze. 2d clips are never fogged. ' +
      'null switches fog off; an object may be given in part (it is laid over the fog the project has, or over a default fog when there is none). ' +
      'light is what 3d clips with lit (update_clip lit 0..1) are shaded by: sky, horizon, ground (hex), a sun (sun 0..1, sunColor, sunTurn, sunHeight); ' +
      'null = take it from the sky when there is one, else from the scene (the background, the filled 2d shapes under the lowest 3d clip and the fog; pictures, video and text are not read; get_project autoLight shows what that gives at the playhead). light only darkens or tints: white light gives the picture back, a dark scene makes it darker. ' +
      'an object may be given in part (laid over the own light, or when there is none over the light the sky gives, its sun included, when there is a sky, else over the scene sky, horizon and ground at the playhead plus a default sun: sun 0.4, sunColor #fff4e0, sunTurn -35, sunHeight 45; send sun 0 for the dome alone). ' +
      'sky is a skybox drawn behind every layer, far away, turning with the camera, made of image media of the project: { media } with 1 picture (a cross 4:3 or 3:4, a strip 6:1 or 1:6) or 6 side pictures in any order named like px nx py ny pz nz, posx ..., right left top bottom front back or rt lf up dn ft bk (word names get a seam check that may swap left and right or turn the top and bottom: notes says what it did), or { faces, turns? } with the 6 ids in side order. turn, brightness and blur may come with it or alone. lit 3d clips take their light from the sky unless there is an own light; that light is measured from the pictures and cannot be sent. 2:1 panoramas, hdr and exr are refused. null takes the sky off (its pictures stay in the media). ' +
      'send only what changes; a call that changes nothing is an error. answers the project summary, the fog, the light and the sky (each an object, or null), and notes when the sides were changed.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 200 },
        width: { type: 'integer', minimum: 16, maximum: 7680 },
        height: { type: 'integer', minimum: 16, maximum: 7680 },
        fps: { type: 'number', minimum: 1, maximum: MAX_FPS },
        background: { type: 'string', maxLength: 9, description: 'hex color: #rgb, #rrggbb or #rrggbbaa' },
        // no type here: the validator refuses null for an object, and null switches the fog off
        fog: {
          description: 'haze over the 3d space, or null for none. an object may be given in part',
          properties: {
            color: { type: 'string', maxLength: 9, description: 'hex color: #rgb, #rrggbb or #rrggbbaa' },
            near: { type: 'number', minimum: 0, maximum: FOG_MAX - FOG_GAP, description: 'distance from the camera where the haze starts, project pixels' },
            far: { type: 'number', minimum: FOG_GAP, maximum: FOG_MAX, description: 'distance where it reaches amount, project pixels' },
            amount: { type: 'number', minimum: 0, maximum: 1, description: 'strongest haze' },
          },
        },
        // no type here either: null takes the light from the scene
        light: {
          description: 'the light of lit 3d clips, or null to take it from the sky when there is one, else from the scene. an object may be given in part (over no own light it starts with the light of the sky, or with a 0.4 sun)',
          properties: {
            sky: { type: 'string', maxLength: 9, description: 'hex color' },
            horizon: { type: 'string', maxLength: 9, description: 'hex color' },
            ground: { type: 'string', maxLength: 9, description: 'hex color' },
            sun: { type: 'number', minimum: 0, maximum: 1 },
            sunColor: { type: 'string', maxLength: 9, description: 'hex color' },
            sunTurn: { type: 'number', minimum: -180, maximum: 180, description: 'degrees, 0 = behind the camera, 90 = to the right' },
            sunHeight: { type: 'number', minimum: 0, maximum: 90, description: 'degrees, 90 = straight above' },
          },
        },
        // no type here either: null takes the sky off
        sky: {
          description: 'a skybox from image media, or null for none. an object may be given in part (turn, brightness or blur alone change the sky the project has)',
          properties: {
            media: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6, description: 'media ids: 1 cross or strip picture, or 6 side pictures named like px nx py ny pz nz or right left top bottom front back' },
            faces: { type: 'array', items: { type: 'string' }, minItems: 6, maxItems: 6, description: 'instead of media: the 6 side pictures in the order right, left, top, bottom, front, back (names are not read)' },
            turns: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 3 }, minItems: 6, maxItems: 6, description: 'with faces: quarter turns clockwise per side' },
            turn: { type: 'number', minimum: -180, maximum: 180, description: 'degrees, like a camera pan: 90 = its right side ahead' },
            brightness: { type: 'number', minimum: 0, maximum: 2, description: '1 = as the pictures are' },
            blur: { type: 'number', minimum: 0, maximum: 1, description: '0 = sharp' },
            // no type: the validator lets it through and laySky answers with the text that says what to send instead
            light: { description: 'not taken: measured from the pictures. send light (top level) for an own light' },
          },
        },
      },
    },
    async run(args) {
      const before = needProject();
      const patch: Parameters<ReturnType<typeof useEditor.getState>['updateProject']>[0] = {};
      const name = cleanName(args.name, 'name');
      if (name !== undefined) patch.name = name;
      if (typeof args.width === 'number') patch.width = args.width;
      if (typeof args.height === 'number') patch.height = args.height;
      if (typeof args.fps === 'number') patch.fps = args.fps;
      if (typeof args.background === 'string') {
        if (!COLOR.test(args.background)) throw new ToolError('background must be a hex color like #101010');
        patch.background = args.background;
      }
      const sameFog = args.fog !== undefined ? layFog(before, args.fog, patch) : false;
      const sameLight_ = args.light !== undefined ? layLight(before, args.light, patch, usePlayback.getState().time) : false;
      const skyRes = args.sky !== undefined ? await laySky(before, args.sky, patch) : { same: false, notes: [] as string[] };
      if (args.sky !== undefined && useEditor.getState().project?.id !== before.id) throw new ToolError('the open project changed while the sky pictures were read. nothing changed');
      if (Object.keys(patch).length === 0) {
        if (sameFog || sameLight_ || skyRes.same) throw new ToolError('the project already has those settings, nothing changed');
        throw new ToolError('nothing to change: send name, width, height, fps, background, fog, light or sky');
      }
      const base = needProject();
      useEditor.getState().updateProject(patch);
      if (!changedSince(base)) throw new ToolError('the project already has those settings, nothing changed');
      const after = needProject();
      return ok({ ...projectBrief(after), fog: fogOf(after), light: lightOf(after), sky: skyOf(after), ...(skyRes.notes.length ? { notes: skyRes.notes } : {}) });
    },
  },
  {
    name: 'get_project',
    title: 'read the project',
    description:
      'the contents of the open project: tracks top to bottom (id, kind, name, muted, hidden, locked), every clip as one short line (id, type, track, start, end, name, ' +
      'and what picks it out: media id, text, shape kind, effect), the media (id, name, kind, duration, size), markers, the fog and the light (each an object, or null), the sky (an object or null: its pictures, turn, brightness, blur and the light measured from it, missing: true when its pictures are gone), autoLight (the sky, horizon and ground colors the scene would give 3d clips at the playhead; from the sky when there is one, also while an own light is set: then lit clips get light, not autoLight) and the duration, all in seconds and project pixels. ' +
      'it holds no keyframe values and no styling: get_clip gives one whole clip. the first track listed is the top layer.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run() {
      const p = needProject();
      return ok({
        ...projectBrief(p),
        fog: fogOf(p),
        light: lightOf(p),
        sky: skyOf(p),
        autoLight: autoLightAt(p, sceneTime(p, usePlayback.getState().time)),
        trackList: p.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, muted: t.muted, hidden: t.hidden, locked: t.locked })),
        clipList: p.clips.map(clipBrief),
        mediaList: p.assets.map((a) => ({ id: a.id, name: a.name, kind: a.kind, duration: round(a.duration), width: a.width, height: a.height, hasAudio: a.hasAudio })),
        markerList: (p.markers ?? []).map((m) => ({ id: m.id, time: round(m.time), name: m.name })),
      });
    },
  },
  {
    name: 'get_clip',
    title: 'read one clip',
    description:
      'one clip exactly as stored (every field, keyframes included), plus "animatable": the properties set_keyframe and update_clip can animate (prop, label, min, max, unit), ' +
      'and for a 3d solid "sides": the side names set_sides takes. for what the fields mean see list_options with kind "fields". ids come from get_project.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'clip id' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: true },
    run(args) {
      const clip = needClip(args.id);
      const animatable: Record<string, unknown>[] = animProps(clip).map((a) => ({ ...a }));
      if (clip.type === 'effect') {
        // the effect's own numbers are keyed as p.<key>
        for (const prm of getEffect(clip.effect)?.params ?? []) {
          animatable.push({ prop: `p.${prm.key}`, label: prm.label, min: prm.min, max: prm.max, ...(prm.unit ? { unit: prm.unit } : {}) });
        }
      }
      const out: Record<string, unknown> = { clip: structuredClone(clip), animatable };
      if ('threeD' in clip && clip.threeD) {
        const names = faceNames(clip.shape);
        if (names.length > 0) out.sides = [...names];
      }
      return ok(out);
    },
  },
  {
    name: 'select_clips',
    title: 'select clips',
    description:
      'makes these clips the selection (replacing the old one); an empty list clears it. ids come from get_project. ' +
      'unknown ids and clips on locked tracks are errors and leave the selection as it was. several tools take the selection as their default target.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, maxItems: 1000, description: 'clip ids' } },
      required: ['ids'],
    },
    run(args) {
      const p = needProject();
      const ids = (args.ids as string[]).filter((x, i, all) => all.indexOf(x) === i);
      const unknown = ids.filter((id) => !p.clips.some((c) => c.id === id));
      if (unknown.length > 0) throw new ToolError(`no clip with the id ${unknown.join(', ')}. get_project lists the clips`);
      const locked = ids.filter((id) => p.tracks.find((t) => t.id === p.clips.find((c) => c.id === id)?.trackId)?.locked);
      if (locked.length > 0) throw new ToolError(`these clips are on a locked track and cannot be selected: ${locked.join(', ')}. unlock the track with update_track`);
      useEditor.getState().select(ids);
      return ok({ selection: useEditor.getState().selection });
    },
  },
  {
    name: 'seek',
    title: 'move the playhead',
    description:
      'moves the playhead to a timeline time in seconds. it is clamped to 0..project length (the end of the last clip); playback keeps running if it was. ' +
      'answers the time it landed on. render_frame can take a time of its own, seek is for what the user sees in the window.',
    inputSchema: {
      type: 'object',
      properties: { time: { type: 'number', minimum: 0, maximum: 86400, description: 'timeline seconds' } },
      required: ['time'],
    },
    run(args) {
      const p = needProject();
      const want = args.time as number;
      usePlayback.getState().seek(want);
      const time = usePlayback.getState().time;
      return ok({ time: round(time), duration: round(projectDuration(p)), ...(time < want ? { clamped: true } : {}) });
    },
  },
  {
    name: 'undo',
    title: 'undo edits',
    description:
      'takes back the last edits, one step each (a tool that edits is one step). steps 1..50, default 1. answers how many were undone and how many are left; ' +
      'it is an error when there is nothing to undo. redo brings steps back. media imports are not part of history.',
    inputSchema: {
      type: 'object',
      properties: { steps: { type: 'integer', minimum: 1, maximum: MAX_UNDO_STEPS, description: 'default 1' } },
    },
    run(args) {
      needProject();
      const want = optNumber(args.steps) ?? 1;
      let done = 0;
      for (let i = 0; i < want; i++) {
        const before = useEditor.getState().project;
        useEditor.getState().undo();
        if (useEditor.getState().project === before) break;
        done++;
      }
      if (done === 0) throw new ToolError('nothing to undo');
      const s = useEditor.getState();
      return ok({ done, requested: want, undoSteps: s.past.length, redoSteps: s.future.length });
    },
  },
  {
    name: 'redo',
    title: 'redo edits',
    description:
      'brings back edits that undo took away, one step each. steps 1..50, default 1. answers how many were redone and how many are left; ' +
      'an error when there is nothing to redo (a new edit empties the redo list).',
    inputSchema: {
      type: 'object',
      properties: { steps: { type: 'integer', minimum: 1, maximum: MAX_UNDO_STEPS, description: 'default 1' } },
    },
    run(args) {
      needProject();
      const want = optNumber(args.steps) ?? 1;
      let done = 0;
      for (let i = 0; i < want; i++) {
        const before = useEditor.getState().project;
        useEditor.getState().redo();
        if (useEditor.getState().project === before) break;
        done++;
      }
      if (done === 0) throw new ToolError('nothing to redo');
      const s = useEditor.getState();
      return ok({ done, requested: want, undoSteps: s.past.length, redoSteps: s.future.length });
    },
  },
  {
    name: 'add_track',
    title: 'add a track',
    description:
      'adds an empty track. video tracks hold pictures, text, shapes, effects and cameras and are added on top (the top track is the top layer); audio tracks hold sounds and are added at the bottom. ' +
      'index is the position in the track list from get_project (0 = top) and is clamped inside the video or audio group. answers the new track id and its position.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['video', 'audio'] },
        index: { type: 'integer', minimum: 0, maximum: 200, description: 'position in the track list, 0 = top' },
        name: { type: 'string', maxLength: 100 },
      },
      required: ['kind'],
    },
    run(args) {
      needProject();
      const name = cleanName(args.name, 'name');
      const index = optNumber(args.index);
      const id = oneStep((opts) => {
        const made = useEditor.getState().addTrack(args.kind as 'video' | 'audio', { ...opts, ...(index !== undefined ? { index } : {}) });
        if (made && name) useEditor.getState().updateTrack(made, { name }, opts);
        return made;
      });
      if (!id) throw new ToolError('the track could not be added');
      const p = needProject();
      const track = needTrack(id);
      return ok({ id, kind: track.kind, name: track.name, index: p.tracks.findIndex((t) => t.id === id) });
    },
  },
  {
    name: 'update_track',
    title: 'change a track',
    description:
      'renames a track or sets muted (silences its audio), hidden (video tracks only: its pictures are not drawn) or locked (its clips cannot be edited or selected). ' +
      'one undo step. send only what changes; a call that changes nothing is an error. ids come from get_project.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'track id' },
        name: { type: 'string', maxLength: 100 },
        muted: { type: 'boolean' },
        hidden: { type: 'boolean' },
        locked: { type: 'boolean' },
      },
      required: ['id'],
    },
    run(args) {
      const before = needProject();
      const track = needTrack(args.id);
      const patch: Parameters<ReturnType<typeof useEditor.getState>['updateTrack']>[1] = {};
      const name = cleanName(args.name, 'name');
      if (name !== undefined) patch.name = name;
      if (typeof args.muted === 'boolean') patch.muted = args.muted;
      if (typeof args.hidden === 'boolean') {
        if (track.kind === 'audio') throw new ToolError('hidden only applies to video tracks. use muted for an audio track');
        patch.hidden = args.hidden;
      }
      if (typeof args.locked === 'boolean') patch.locked = args.locked;
      if (Object.keys(patch).length === 0) throw new ToolError('nothing to change: send name, muted, hidden or locked');
      // the store writes a step even for equal values, so compare here
      const same = (Object.keys(patch) as (keyof typeof patch)[]).every((k) => track[k] === patch[k]);
      if (same) throw new ToolError(`the track ${track.id} already has those settings, nothing changed`);
      useEditor.getState().updateTrack(track.id, patch);
      if (!changedSince(before)) throw new ToolError(`the track ${track.id} could not be changed`);
      const now = needTrack(track.id);
      return ok({ id: now.id, kind: now.kind, name: now.name, muted: now.muted, hidden: now.hidden, locked: now.locked });
    },
  },
  {
    name: 'remove_track',
    title: 'remove a track',
    description:
      'removes a track and every clip on it (also effects aimed at those clips). one undo step, so undo brings it back. ' +
      'answers how many clips went with it. to keep the clips, move_clip them to another track first. a locked track is refused: unlock it with update_track first.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'track id' } },
      required: ['id'],
    },
    annotations: { destructiveHint: true },
    run(args) {
      const before = needProject();
      const track = needTrack(args.id);
      if (track.locked) throw new ToolError(`the track ${track.id} (${track.name}) is locked. unlock it with update_track first`);
      useEditor.getState().removeTrack(track.id);
      if (!changedSince(before)) throw new ToolError(`the track ${track.id} could not be removed`);
      return ok({ removed: track.id, name: track.name, clipsRemoved: before.clips.length - needProject().clips.length });
    },
  },
  {
    name: 'add_marker',
    title: 'add a marker',
    description:
      'puts a named marker on the timeline at a time in seconds (markers help with snapping and jumping). one undo step. ' +
      'an error when a marker already sits within a millisecond of that time. answers the marker id.',
    inputSchema: {
      type: 'object',
      properties: {
        time: { type: 'number', minimum: 0, maximum: 86400, description: 'timeline seconds' },
        name: { type: 'string', maxLength: 200 },
      },
      required: ['time'],
    },
    run(args) {
      const before = needProject();
      const time = args.time as number;
      const near = before.markers?.find((m) => Math.abs(m.time - time) <= 1e-3);
      if (near) throw new ToolError(`the marker ${near.id} already sits at ${round(near.time)}. remove_marker it first or pick another time`);
      const id = useEditor.getState().addMarker(time, optString(args.name) ?? '');
      const made = needProject().markers?.find((m) => m.id === id);
      if (!made) throw new ToolError('the marker could not be added');
      return ok({ id: made.id, time: round(made.time), name: made.name });
    },
  },
  {
    name: 'remove_marker',
    title: 'remove a marker',
    description: 'removes a marker by id (get_project lists them). one undo step.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'marker id' } },
      required: ['id'],
    },
    annotations: { destructiveHint: true },
    run(args) {
      const p = needProject();
      if (!p.markers?.some((m) => m.id === args.id)) throw new ToolError(`no marker with the id ${String(args.id)}. get_project lists the markers`);
      useEditor.getState().removeMarker(String(args.id));
      return ok({ removed: args.id });
    },
  },
];

