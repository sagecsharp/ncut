/** clear on / off switch: a button that reads "on" or "off" */
export function Switch({ checked, title, onChange }: { checked: boolean; title: string; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`btn btn-sm props-switch${checked ? ' btn-primary' : ''}`}
      title={title}
      aria-label={title}
      onClick={() => onChange(!checked)}
    >
      {checked ? 'on' : 'off'}
    </button>
  );
}
