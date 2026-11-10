/** STUB: replaced by the real font picker (search, categories, previews in each font). */
import { FONT_FAMILIES } from '../../lib/factory';

export interface FontPickerProps {
  /** css font-family of the clip */
  value: string;
  onChange(family: string): void;
  id?: string;
}

export function FontPicker({ value, onChange, id }: FontPickerProps) {
  const fonts = FONT_FAMILIES.includes(value) ? FONT_FAMILIES : [value, ...FONT_FAMILIES];
  return (
    <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      {fonts.map((f) => (
        <option key={f} value={f}>
          {f.toLowerCase()}
        </option>
      ))}
    </select>
  );
}
