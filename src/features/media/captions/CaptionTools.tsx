import { useMemo, useRef } from 'react';
import { Captions, FileDown, Scissors } from 'lucide-react';
import { parseSubtitles, toSrt } from '../../../lib/subtitles';
import type { Cue } from '../../../lib/subtitles';
import { useEditor } from '../../../store/editorStore';
import { useUi } from '../../../store/ui';
import { clipsToCues, cuesToClips, splitTextClip } from './cues';
import './captions.css';

const editor = () => useEditor.getState();

/** save text as a file through a temporary link */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-subrip;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function fileName(project: string): string {
  const base = project.trim().replace(/[\/:*?"<>|]+/g, '-') || 'captions';
  return `${base}.srt`;
}

/** caption tools shown in the text tab: import .srt / .vtt as text clips, cut a text into captions, export the texts as .srt */
export function CaptionTools() {
  const fileRef = useRef<HTMLInputElement>(null);
  const clips = useEditor((s) => s.project?.clips);
  const selection = useEditor((s) => s.selection);

  const textCount = useMemo(() => (clips ?? []).reduce((n, c) => n + (c.type === 'text' ? 1 : 0), 0), [clips]);
  const selectedText = useMemo(() => {
    if (!clips || selection.length !== 1) return null;
    const c = clips.find((x) => x.id === selection[0]);
    return c && c.type === 'text' ? c : null;
  }, [clips, selection]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const { project } = editor();
    if (!project) return;
    let cues: Cue[];
    try {
      cues = parseSubtitles(await file.text());
    } catch {
      cues = [];
    }
    const made = cuesToClips(cues, project.width, project.height);
    if (made.length === 0) {
      useUi.getState().toast('no captions found in that file', 'error');
      return;
    }
    const ids = editor().addClips(made, { trackName: 'captions' });
    useUi.getState().toast(ids.length === 1 ? 'added 1 caption' : `added ${ids.length} captions`);
  };

  const split = () => {
    if (!selectedText) return;
    const pieces = splitTextClip(selectedText);
    if (pieces.length === 0) {
      useUi.getState().toast('that text is already short enough');
      return;
    }
    const s = editor();
    // one undo step: remember once, then change quietly
    s.pushHistory();
    s.deleteClips([selectedText.id], { skipHistory: true });
    const ids = s.addClips(pieces, { newTrack: false, skipHistory: true });
    useUi.getState().toast(`split into ${ids.length} captions`);
  };

  const exportSrt = () => {
    const { project } = editor();
    if (!project) return;
    const cues = clipsToCues(project.clips);
    if (cues.length === 0) return;
    download(fileName(project.name), toSrt(cues));
  };

  return (
    <div className="caption-tools">
      <span className="caption-tools-title">captions</span>
      <button
        type="button"
        className="btn btn-sm"
        title="import captions from an .srt or .vtt file as text clips on a new track"
        aria-label="import captions"
        onClick={() => fileRef.current?.click()}
      >
        <Captions size={14} />
        <span>import</span>
      </button>
      <input
        ref={fileRef}
        type="file"
        hidden
        accept=".srt,.vtt"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          void onFile(f);
        }}
      />
      <button
        type="button"
        className="btn btn-sm"
        title="split the selected text into caption sized pieces over the same time"
        aria-label="split text into captions"
        disabled={!selectedText}
        onClick={split}
      >
        <Scissors size={14} />
        <span>split</span>
      </button>
      <button
        type="button"
        className="btn btn-sm"
        title="save every text clip as an .srt file"
        aria-label="export captions"
        disabled={textCount === 0}
        onClick={exportSrt}
      >
        <FileDown size={14} />
        <span>export</span>
      </button>
    </div>
  );
}
