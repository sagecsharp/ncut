import { describe, expect, it } from 'vitest';
import { dataUrlToBlob } from './dataUrl';

describe('dataUrlToBlob', () => {
  it('gives the bytes and the type', async () => {
    const blob = dataUrlToBlob('data:image/jpeg;base64,' + btoa('\xff\xd8\xff\xe0abc\x00\x01'));
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('image/jpeg');
    expect([...new Uint8Array(await blob!.arrayBuffer())]).toEqual([0xff, 0xd8, 0xff, 0xe0, 97, 98, 99, 0, 1]);
  });
  it('says no to everything else', () => {
    expect(dataUrlToBlob('data:,')).toBeNull();
    expect(dataUrlToBlob('data:image/png;base64,')).toBeNull();
    expect(dataUrlToBlob('data:text/plain,hello')).toBeNull();
    expect(dataUrlToBlob('data:;base64,AAAA')).toBeNull();
    expect(dataUrlToBlob('data:image/png;base64,***')).toBeNull();
    expect(dataUrlToBlob('blob:app://ncut/1234')).toBeNull();
    expect(dataUrlToBlob('')).toBeNull();
    expect(dataUrlToBlob(undefined as unknown as string)).toBeNull();
  });
});
