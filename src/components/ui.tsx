import { useEffect, useId, useRef, type ReactNode } from 'react'
import { useObjectUrl } from './useObjectUrl'
import { formatMoney } from '../lib/format'

export function Money({ value, className = '' }: { value: number; className?: string }) {
  return <span className={`num ${className}`}>{formatMoney(value)}</span>
}

export function ErrorBox({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <span className="flex-1">{children}</span>
      {onRetry && (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          נסו שוב
        </button>
      )}
    </div>
  )
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  const cls = tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-stone-200 bg-white text-stone-700'
  return <div className={`rounded-lg border px-4 py-3 text-sm ${cls}`}>{children}</div>
}

export function Spinner({ label = 'טוען…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-6 text-sm text-stone-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-accent" />
      {label}
    </div>
  )
}

interface FieldProps {
  label: string
  value: string
  onChange: (v: string) => void
  type?: 'text' | 'number'
  suffix?: string
  placeholder?: string
  required?: boolean
  className?: string
  inputRef?: React.Ref<HTMLInputElement>
  disabled?: boolean
  hint?: string
  /** Text direction of the input; number fields are always LTR. */
  dir?: 'ltr' | 'rtl'
  inputMode?: 'text' | 'email' | 'decimal' | 'tel'
  autoComplete?: string
}

/**
 * Labelled input. `type="number"` renders a text input with a decimal keyboard: the raw text is kept, so a
 * malformed entry (e.g. "1,5,2") is flagged by validation instead of the browser silently turning it into "".
 */
export function Field({
  label,
  value,
  onChange,
  type = 'text',
  suffix,
  placeholder,
  required,
  className = '',
  inputRef,
  disabled,
  hint,
  dir,
  inputMode,
  autoComplete,
}: FieldProps) {
  const id = useId()
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <label htmlFor={id}>
        {label}
        {required && <span className="text-accent"> *</span>}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          ref={inputRef}
          type="text"
          inputMode={type === 'number' ? 'decimal' : inputMode}
          autoComplete={type === 'number' ? 'off' : autoComplete}
          dir={type === 'number' ? 'ltr' : dir}
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="w-full"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix && <span className="shrink-0 text-sm text-stone-500">{suffix}</span>}
      </div>
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-amber-800">
          {hint}
        </p>
      )}
    </div>
  )
}

export function BlobImage({ blob, alt, className = '' }: { blob: Blob; alt: string; className?: string }) {
  const url = useObjectUrl(blob)
  if (!url) return <div className={`bg-stone-100 ${className}`} aria-label={alt} />
  return <img src={url} alt={alt} className={className} />
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Accessible in-app modal: role="dialog" + aria-modal, labelled by its title, focus goes into it (to `initialFocus`
 * or the dialog itself), Tab / Shift+Tab stay inside (focus trap), Escape closes, and focus returns to the element
 * that opened it. Never use window.confirm / alert.
 */
export function Dialog({
  title,
  children,
  onClose,
  describedBy,
  initialFocus,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  /** id of the element that describes the dialog (aria-describedby). */
  describedBy?: string
  initialFocus?: React.RefObject<HTMLElement | null>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  // The latest onClose, so a new callback each render neither re-runs the effect nor steals focus.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ;(initialFocus?.current ?? ref.current)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab' || !ref.current) return
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) {
        e.preventDefault()
        ref.current.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      const inside = active instanceof Node && ref.current.contains(active)
      if (e.shiftKey && (active === first || active === ref.current || !inside)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (opener && opener.isConnected) opener.focus()
    }
    // Runs once per opening; initialFocus is a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        className="card w-full max-w-md outline-none"
      >
        <h2 id={titleId} className="mb-3 text-lg font-bold">
          {title}
        </h2>
        {children}
      </div>
    </div>
  )
}

/** Yes/no question in an accessible modal (Escape or "ביטול" = cancel). Focus starts on cancel (the safe choice). */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = 'ביטול',
  onConfirm,
  onCancel,
}: {
  title: string
  message: ReactNode
  confirmLabel: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const messageId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog title={title} onClose={onCancel} describedBy={messageId} initialFocus={cancelRef}>
      <p id={messageId} className="mb-4 text-stone-700">
        {message}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </Dialog>
  )
}

export function PlaceholderImage({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center bg-stone-100 text-stone-400 ${className}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" className="h-10 w-10" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" strokeLinejoin="round" />
        <path d="M4 7.5l8 4.5 8-4.5M12 12v9" strokeLinejoin="round" />
      </svg>
    </div>
  )
}
