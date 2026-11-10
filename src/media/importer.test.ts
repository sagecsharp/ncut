import { describe, expect, it } from 'vitest';
import { detectKind } from './importer';

describe('detectKind', () => {
  it('goes by the type the system gives', () => {
    expect(detectKind({ type: 'video/mp4', name: 'a.bin' })).toBe('video');
    expect(detectKind({ type: 'audio/mpeg', name: 'a' })).toBe('audio');
    expect(detectKind({ type: 'image/png', name: 'a.txt' })).toBe('image');
  });
  it('goes by the file name when there is no type', () => {
    expect(detectKind({ type: '', name: 'clip.MOV' })).toBe('video');
    expect(detectKind({ type: 'application/octet-stream', name: 'song.flac' })).toBe('audio');
    expect(detectKind({ type: '', name: 'pic.webp' })).toBe('image');
  });
  it('goes by the file name when the type is not a media type (ogg is often application/ogg)', () => {
    expect(detectKind({ type: 'application/ogg', name: 'voice.ogg' })).toBe('audio');
    expect(detectKind({ type: 'application/ogg', name: 'film.ogv' })).toBe('video');
    expect(detectKind({ type: 'application/x-matroska', name: 'film.mkv' })).toBe('video');
    expect(detectKind({ type: 'application/mp4', name: 'film.mp4' })).toBe('video');
  });
  it('says no to files that are not media', () => {
    expect(detectKind({ type: 'application/pdf', name: 'a.pdf' })).toBeNull();
    expect(detectKind({ type: 'text/plain', name: 'notes.txt' })).toBeNull();
    expect(detectKind({ type: '', name: 'noextension' })).toBeNull();
    expect(detectKind({ type: 'application/zip', name: 'project.ncut' })).toBeNull();
  });
});
