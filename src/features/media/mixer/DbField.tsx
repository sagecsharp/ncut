import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ActionOpts } from '../../../store/editorStore';
import { parseTyped } from '../../../components/ui/sliderMath';
import { dbToGain, FADER_MAX_DB, formatDb, gainToDb, parseDb } from '../../../lib/mix';

interface Props {
  /** the level, linear */
  gain: number;
  /** null = 0 db */
  write(gain: number | null, opts?: ActionOpts): void;
}

/** the level in db as a button; a click turns it into a box to type in (-6, off, 50%, maths works) */
export function DbField({ gain, write }: Props) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const opened = useRef('');
  const db = gainToDb(gain);

  useEffect(() => {
    if (!typing) return;
    input.current?.focus();
    input.current?.select();
  }, [typing]);

  const open = () => {
    done.current = false;
    const text = formatDb(db).replace(/ db$/, '');
    opened.current = text;
    setDraft(text);
    setTyping(true);
  };

  const keep = () => {
    if (done.current) return;
    done.current = true;
    setTyping(false);
    // nothing typed: the level stays as it is, no undo step
    if (draft.trim() === opened.current) return;
    const v = parseDb(draft) ?? parseTyped(draft);
    if (v === null || Number.isNaN(v)) return;
    const next = Math.min(FADER_MAX_DB, v);
    write(next === 0 ? null : dbToGain(next));
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') keep();
    else if (e.key === 'Escape') {
      done.current = true;
      setTyping(false);
    }
  };

  if (typing) {
    return (
      <input
        ref={input}
        className="input input-sm mixer-db-input"
        value={draft}
        aria-label="level in db"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={keep}
        onKeyDown={onKey}
      />
    );
  }
  return (
    <button type="button" className="mixer-db" title="type a level in db, like -6 or off. maths works" onClick={open}>
      {formatDb(db)}
    </button>
  );
}
