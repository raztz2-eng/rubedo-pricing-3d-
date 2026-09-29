import { editPartValue, type PartDraft } from '../lib/bidForm'
import { Field } from './ui'

export function PartsEditor({ parts, onChange }: { parts: PartDraft[]; onChange: (parts: PartDraft[]) => void }) {
  const replace = (key: string, fn: (p: PartDraft) => PartDraft) => onChange(parts.map((p) => (p.key === key ? fn(p) : p)))

  if (parts.length === 0) {
    return <p className="text-sm text-stone-500">אין עדיין חלקים. העלו קובץ פרוס או הוסיפו חלק ידנית.</p>
  }

  return (
    <div className="flex flex-col gap-3">
      {parts.map((p, i) => (
        <div key={p.key} className="rounded-lg border border-stone-200 p-3" data-testid="part-row">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-semibold">חלק {i + 1}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${p.source === '3mf' ? 'bg-accent-soft text-accent-dark' : 'bg-stone-100 text-stone-600'}`}
              data-testid="part-source"
            >
              {p.source === '3mf' ? 'מקובץ פרוס' : 'ידני'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr]">
            <Field
              className="col-span-2 sm:col-span-1"
              label="שם החלק"
              value={p.name}
              onChange={(v) => replace(p.key, (x) => ({ ...x, name: v }))}
            />
            <Field label="כמות" type="number" value={p.qty} onChange={(v) => replace(p.key, (x) => ({ ...x, qty: v }))} />
            <Field label="משקל" type="number" suffix="ג׳" value={p.grams} onChange={(v) => replace(p.key, (x) => editPartValue(x, 'grams', v))} />
            <Field label="זמן הדפסה" type="number" suffix="שעות" value={p.hours} onChange={(v) => replace(p.key, (x) => editPartValue(x, 'hours', v))} />
          </div>
          <div className="mt-2 text-end">
            <button
              type="button"
              className="btn btn-ghost px-2 py-1 text-red-700"
              aria-label={`הסרת חלק ${i + 1}`}
              onClick={() => onChange(parts.filter((x) => x.key !== p.key))}
            >
              הסרת חלק
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
