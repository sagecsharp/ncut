/**
 * the lut tables of one thread: the main thread, the export workers. no registry, store or dom import, the workers
 * load this file. a table is read once from its media blob and kept; a file that cannot be read is noted once.
 */
import { parseCube, CubeError } from '../lib/cube';
import type { CubeLut, LutTable } from '../lib/cube';
import { lutIdsOf } from '../lib/gradeData';
import type { Project } from '../types';

export type BlobOf = (id: string) => Blob | null | undefined;

const tables = new Map<string, LutTable>();
const problems = new Map<string, string>();
const reading = new Map<string, Promise<LutTable | null>>();
const listeners = new Set<() => void>();

function tell(): void {
  for (const f of [...listeners]) {
    try {
      f();
    } catch {
      // one listener never stops the others
    }
  }
}

/** the table of a lut media, or null when it is not read (yet) */
export function lutTableOf(id: string): LutTable | null {
  return tables.get(id) ?? null;
}

/** why a lut could not be read, null when it was read or not tried */
export function lutProblem(id: string): string | null {
  return problems.get(id) ?? null;
}

/** one parse, one shared promise. no blob: null, nothing noted, no parse (cheap per frame) */
export function requestLut(id: string, blobOf: BlobOf): Promise<LutTable | null> {
  const table = tables.get(id);
  if (table) return Promise.resolve(table);
  if (problems.has(id)) return Promise.resolve(null);
  const going = reading.get(id);
  if (going) return going;
  const blob = blobOf(id);
  if (!blob) return Promise.resolve(null);
  let run: Promise<LutTable | null> | undefined;
  run = (async () => {
    try {
      const cube = parseCube(await blob.text());
      // dropLuts ran while this was parsing: only the awaiters get the table
      if (reading.get(id) !== run) return { ...cube, key: id };
      return putLut(id, cube);
    } catch (e) {
      if (reading.get(id) === run) {
        problems.set(id, e instanceof CubeError ? e.message : 'the file could not be read');
        reading.delete(id);
        tell();
      }
      return null;
    }
  })();
  reading.set(id, run);
  return run;
}

/** a table that is already read (the importer): stored, its problem cleared, the listeners told */
export function putLut(id: string, cube: CubeLut): LutTable {
  const table: LutTable = { ...cube, key: id };
  tables.set(id, table);
  problems.delete(id);
  reading.delete(id);
  tell();
  return table;
}

/** forgets every table, problem and parse in flight of the ids not in keep. no listener call */
export function dropLuts(keep: ReadonlySet<string>): void {
  for (const m of [tables, problems, reading] as Map<string, unknown>[]) {
    for (const id of [...m.keys()]) if (!keep.has(id)) m.delete(id);
  }
}

/** f runs when a table was read or failed. answers the remove */
export function onLutChange(f: () => void): () => void {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

/** the export: reads every table at once. the map keeps its tables after any dropLuts */
export async function loadLutTables(ids: Iterable<string>, blobOf: BlobOf, onWarning?: (m: string) => void, nameOf?: (id: string) => string): Promise<Map<string, LutTable>> {
  const unique = [...new Set(ids)];
  const got = await Promise.all(unique.map((id) => requestLut(id, blobOf)));
  const out = new Map<string, LutTable>();
  unique.forEach((id, i) => {
    const t = got[i];
    if (t) out.set(id, t);
    else onWarning?.(`could not read the lut "${nameOf?.(id) ?? id}", its clips are exported without it`);
  });
  return out;
}

/** the lut media a project's grades use, in clip order: only ids that are a media of kind 'lut' (a gone id is left out) */
export function usedLutIds(project: Pick<Project, 'clips' | 'assets'>): string[] {
  const kinds = new Map(project.assets.map((a) => [a.id, a.kind]));
  return [...lutIdsOf(project.clips)].filter((id) => kinds.get(id) === 'lut');
}
