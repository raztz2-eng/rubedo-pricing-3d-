import { useId, useMemo, useState, type KeyboardEvent } from 'react'
import { pickerCustomers, type Customer } from '../lib/customers'

export const CUSTOMER_PICKER_LABEL = 'בחירת לקוח קיים'
const MAX_OPTIONS = 8

/**
 * Type-ahead customer picker (brief v0.6 E4) — an ARIA 1.2 combobox with a listbox popup:
 * ↓/↑ change the active option, Enter picks, Escape closes. Hidden customers are not offered. RTL; e-mails shown LTR.
 */
export function CustomerPicker({
  customers,
  onPick,
  disabled,
}: {
  customers: readonly Customer[]
  onPick: (customer: Customer) => void
  disabled?: boolean
}) {
  const id = useId()
  const listId = `${id}-list`
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  const options = useMemo(() => pickerCustomers(customers, query).slice(0, MAX_OPTIONS), [customers, query])
  const expanded = open && options.length > 0
  const activeIndex = active >= 0 && active < options.length ? active : -1

  const pick = (c: Customer) => {
    onPick(c)
    setQuery('')
    setOpen(false)
    setActive(-1)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((i) => (options.length === 0 ? -1 : i < 0 || i >= options.length - 1 ? 0 : i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
      setActive((i) => (options.length === 0 ? -1 : i <= 0 ? options.length - 1 : i - 1))
    } else if (e.key === 'Enter') {
      if (expanded && activeIndex >= 0) {
        e.preventDefault()
        pick(options[activeIndex])
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        setOpen(false)
        setActive(-1)
      }
    }
  }

  return (
    <div className="relative flex flex-col gap-1">
      <label htmlFor={id}>{CUSTOMER_PICKER_LABEL}</label>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && activeIndex >= 0 ? `${id}-opt-${activeIndex}` : undefined}
        autoComplete="off"
        placeholder={customers.length === 0 ? 'אין עדיין לקוחות שמורים' : 'הקלידו שם או מייל…'}
        value={query}
        disabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label="לקוחות"
        hidden={!expanded}
        className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-auto rounded-lg border border-stone-200 bg-white shadow-lg"
      >
        {options.map((c, i) => (
          <li
            key={c.id}
            id={`${id}-opt-${i}`}
            role="option"
            aria-selected={i === activeIndex}
            className={`flex cursor-pointer flex-wrap items-baseline justify-between gap-x-3 px-3 py-2 text-sm ${
              i === activeIndex ? 'bg-accent-soft' : 'hover:bg-stone-50'
            }`}
            // mousedown (not click): picking must happen before the input's blur closes the list.
            onMouseDown={(e) => {
              e.preventDefault()
              pick(c)
            }}
            onMouseEnter={() => setActive(i)}
          >
            <span className="font-medium">{c.name}</span>
            <span className="text-xs text-stone-500" dir="ltr">
              {c.email}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
