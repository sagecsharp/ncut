/**
 * the bytes of a base64 data url (what canvas.toDataURL gives) as a blob. null for anything else.
 *
 * why not canvas.toBlob: chromium encodes for toBlob / convertToBlob in an idle moment of the page and waits up
 * to a second for one. toDataURL encodes on the spot, which is a millisecond for a poster sized picture.
 */
export function dataUrlToBlob(url: string): Blob | null {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const head = url.slice(5, comma);
  if (!head.endsWith(';base64')) return null;
  const mime = head.slice(0, -7);
  // a canvas that cannot encode gives 'data:,' and one without the asked type falls back to png: the caller asked for a type
  if (!mime) return null;
  try {
    const text = atob(url.slice(comma + 1));
    if (text.length === 0) return null;
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}
