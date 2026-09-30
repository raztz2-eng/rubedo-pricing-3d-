import { emptyLine, type LineDraft } from '../lib/bidForm'
import { Field } from './ui'

/**
 * Editable list of {name, qty, unitCost} rows (hardware, packaging).
 * `includable` (hardware, v0.5 Q1): each row gets a "כלול במחיר" checkbox (default on); unticked rows stay in the list.
 */
export function LineItemsEditor({
  lines,
  onChange,
  addLabel,
  itemLabel,
  includable = false,
}: {
  lines: LineDraft[]
  onChange: (lines: LineDraft[]) => void
  addLabel: string
  itemLabel: string
  includable?: boolean
}) {
  const update = (key: string, patch: Partial<LineDraft>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  return (
    <div className="flex flex-col gap-3">
      {lines.map((l, i) => (
        <div key={l.key} className={`grid grid-cols-2 items-end gap-2 rounded-lg p-2 ${
            includable ? 'sm:grid-cols-[2fr_1fr_1fr_auto_auto]' : 'sm:grid-cols-[2fr_1fr_1fr_auto]'
          } ${includable && l.included === false ? 'bg-stone-100 opacity-75' : 'bg-stone-50'}`}>
          <Field
            className="col-span-2 sm:col-span-1"
            label={`${itemLabel} ${i + 1}`}
            value={l.name}
            onChange={(v) => update(l.key, { name: v })}
          />
          <Field label="כמות" type="number" value={l.qty} onChange={(v) => update(l.key, { qty: v })} />
          <Field label="מחיר ליחידה" type="number" suffix="₪" value={l.unitCost} onChange={(v) => update(l.key, { unitCost: v })} />
          {includable && (
            <label className="col-span-2 flex items-center gap-2 font-normal sm:col-span-1 sm:pb-2">
              <input
                type="checkbox"
                checked={l.included !== false}
                aria-label={`כלול במחיר — ${itemLabel} ${i + 1}`}
                onChange={(e) => update(l.key, { included: e.target.checked })}
              />
              כלול במחיר
            </label>
          )}
          <button
            type="button"
            className="btn btn-ghost col-span-2 text-red-700 sm:col-span-1"
            aria-label={`הסרת ${itemLabel} ${i + 1}`}
            onClick={() => onChange(lines.filter((x) => x.key !== l.key))}
          >
            הסרה
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="btn btn-secondary" onClick={() => onChange([...lines, emptyLine()])}>
          + {addLabel}
        </button>
      </div>
    </div>
  )
}
