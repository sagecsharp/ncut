/**
 * shared by the transition packs. a pack shader defines `vec4 tr_main(vec2 uv, float p)`; this wraps it so
 * the result is EXACTLY a at p = 0 and EXACTLY b at p = 1 (no matter what the maths does at the ends).
 * p is already eased when it gets here (see easeTransition in ./runner.ts).
 */
export function wrapTransition(body: string): string {
  return `${body}
vec4 transition(vec2 uv, float p) {
  if (p <= 0.0) return a(uv);
  if (p >= 1.0) return b(uv);
  return tr_main(uv, p);
}`;
}

export function wrapAll(defs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of Object.keys(defs)) out[id] = wrapTransition(defs[id]!);
  return out;
}
