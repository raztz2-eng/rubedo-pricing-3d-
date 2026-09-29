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
  step?: string
  min?: string
  className?: string
  inputRef?: React.Ref<HTMLInputElement>
}

/** Labelled input. Numbers are kept as text so an invalid entry is never silently turned into 0. */
export function Field({ label, value, onChange, type = 'text', suffix, placeholder, required, step, min, className = '', inputRef }: FieldProps) {
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
          type={type}
          inputMode={type === 'number' ? 'decimal' : undefined}
          step={type === 'number' ? (step ?? 'any') : undefined}
          min={min}
          dir={type === 'number' ? 'ltr' : undefined}
          className="w-full"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix && <span className="shrink-0 text-sm text-stone-500">{suffix}</span>}
      </div>
    </div>
  )
}

export function BlobImage({ blob, alt, className = '' }: { blob: Blob; alt: string; className?: string }) {
  const url = useObjectUrl(blob)
  if (!url) return <div className={`bg-stone-100 ${className}`} aria-label={alt} />
  return <img src={url} alt={alt} className={className} />
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="card w-full max-w-md outline-none">
        <h2 className="mb-3 text-lg font-bold">{title}</h2>
        {children}
      </div>
    </div>
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
