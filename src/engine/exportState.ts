/**
 * whether an export is running right now. the renderer reads it where the wall clock would otherwise leak
 * into an exported file (retry pauses for fonts and for the 3d renderer) and where the export's resources must
 * not be freed under it (save frame).
 */
let running = 0;

export function beginExport(): void {
  running++;
}

export function endExport(): void {
  running = Math.max(0, running - 1);
}

export function isExporting(): boolean {
  return running > 0;
}
