/**
 * A setting that is on or off, as a row of the Settings window: the label
 * and its hint on the left, a switch on the right, the whole row a label so
 * a press anywhere on it flips the switch.
 */
export function Switch({ label, hint, checked, onChange, testId, disabled = false }: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <label className="pref-row pref-switch">
      <span className="pref-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="pref-track" aria-hidden="true" />
    </label>
  );
}
