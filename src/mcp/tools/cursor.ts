/** the cursor tool (docs/MCP.md, "cursors"): show the user something in the window without changing the project */
import { useMcpCursors } from '../../store/mcpCursors';
import { DEFAULT_CURSOR, describeTarget, pointTarget } from '../cursor';
import { needClip, needProject, needTrack, ok, optString, ToolError } from '../helpers';
import type { ToolDef } from '../types';

const MAX_NOTE = 120;
const MAX_COORD = 100000;

export const cursorTools: ToolDef[] = [
  {
    name: 'point_at',
    title: 'point at something',
    description:
      'moves your cursor in the ncut window to a clip, a track, a time on the time ruler or a spot on the canvas, and shows a short note in a bubble next to it, to tell the user what you mean. ' +
      'give exactly ONE of: clip (a clip id), track (a track id), time (timeline seconds), or x and y together (project pixels, 0 / 0 is the middle of the canvas). ' +
      'note is up to 120 characters. it changes nothing in the project and makes no undo step. the cursor and the note stay for a while (about 30 seconds). ' +
      'answers what it points at; when the user has switched cursors off in the settings it says so (not an error).',
    inputSchema: {
      type: 'object',
      properties: {
        clip: { type: 'string', description: 'clip id' },
        track: { type: 'string', description: 'track id' },
        time: { type: 'number', minimum: 0, maximum: 86400, description: 'timeline seconds' },
        x: { type: 'number', minimum: -MAX_COORD, maximum: MAX_COORD, description: 'canvas x in project pixels, 0 = the middle. needs y' },
        y: { type: 'number', minimum: -MAX_COORD, maximum: MAX_COORD, description: 'canvas y in project pixels, 0 = the middle. needs x' },
        note: { type: 'string', maxLength: MAX_NOTE, description: 'a short text shown next to the cursor' },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run(args, ctx) {
      needProject();
      const given = (['clip', 'track', 'time'] as const).filter((k) => args[k] !== undefined);
      const hasX = args.x !== undefined;
      const hasY = args.y !== undefined;
      if (hasX !== hasY) throw new ToolError(`${hasX ? 'x' : 'y'} needs ${hasX ? 'y' : 'x'} too: a spot on the canvas is x and y together`);
      const kinds = given.length + (hasX ? 1 : 0);
      if (kinds === 0) throw new ToolError('say what to point at: give clip, track, time, or x and y together');
      if (kinds > 1) throw new ToolError(`give exactly one thing to point at, not ${kinds}: ${[...given, ...(hasX ? ['x and y'] : [])].join(', ')}`);
      if (args.clip !== undefined) needClip(args.clip);
      if (args.track !== undefined) needTrack(args.track);
      const note = optString(args.note)?.trim();
      if (args.note !== undefined && !note) throw new ToolError('note is empty: leave it out or write a few words');
      const target = pointTarget(args);
      if (!target) throw new ToolError('could not tell what to point at: give clip, track, time, or x and y together');
      const cursors = useMcpCursors.getState();
      cursors.point(ctx.cursor ?? DEFAULT_CURSOR, target, note ?? null);
      return ok({
        pointing: describeTarget(target),
        ...(note ? { note } : {}),
        shown: cursors.enabled,
        ...(cursors.enabled ? {} : { cursors: 'the user has switched cursors off in the settings, so nothing is drawn. nothing was changed' }),
      });
    },
  },
];
