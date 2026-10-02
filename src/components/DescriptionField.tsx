import { useId } from 'react'
import { DESCRIPTION_MAX_LENGTH, DESCRIPTION_TOO_LONG_MESSAGE } from '../lib/bid'

/**
 * Description textarea with a live character counter (brief v0.6 E3, max 2000). Text beyond the limit is NOT cut
 * off silently: the counter turns red, a Hebrew message appears and the caller blocks saving.
 */
export function DescriptionField({
  value,
  onChange,
  label = 'תיאור',
  rows = 3,
  autoFocus,
  limitApplies = true,
}: {
  value: string
  onChange: (value: string) => void
  label?: string
  rows?: number
  autoFocus?: boolean
  /** False while the text is still the saved one: an older, longer description is not flagged until it is changed. */
  limitApplies?: boolean
}) {
  const id = useId()
  const length = value.trim().length
  const tooLong = limitApplies && length > DESCRIPTION_MAX_LENGTH
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={rows}
        value={value}
        autoFocus={autoFocus}
        aria-invalid={tooLong || undefined}
        aria-describedby={`${id}-count`}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        {tooLong ? (
          <span role="alert" className="text-red-700">
            {DESCRIPTION_TOO_LONG_MESSAGE}
          </span>
        ) : (
          <span />
        )}
        <span id={`${id}-count`} aria-live="polite" className={tooLong ? 'font-semibold text-red-700' : 'text-stone-500'} data-testid="description-counter">
          <span className="num" dir="ltr">
            {length}/{DESCRIPTION_MAX_LENGTH}
          </span>{' '}
          תווים
        </span>
      </div>
    </div>
  )
}
