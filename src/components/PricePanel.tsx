import { formatNumber } from '../lib/format'
import type { PriceResult } from '../lib/pricing'
import { Money } from './ui'

const ROWS: { key: keyof PriceResult; label: string }[] = [
  { key: 'filament', label: 'פילמנט' },
  { key: 'hardware', label: 'חומרה' },
  { key: 'labor', label: 'עבודה' },
  { key: 'packaging', label: 'אריזה ומשלוח' },
  { key: 'machine', label: 'זמן מכונה' },
]

/** Cost breakdown + 50/60/70% prices (70% highlighted). Used live in the form and on the model page. */
export function PricePanel({ result, title = 'מחיר' }: { result: PriceResult; title?: string }) {
  return (
    <section className="card" aria-label="פירוט מחיר" data-testid="price-panel">
      <h2 className="section-title">{title}</h2>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm">
        {ROWS.map((r) => (
          <div key={r.key} className="contents" data-testid={`cost-${r.key}`}>
            <dt className="text-stone-600">{r.label}</dt>
            <dd>
              <Money value={result[r.key]} />
            </dd>
          </div>
        ))}
        <div className="contents font-semibold" data-testid="cost-landed">
          <dt className="border-t border-stone-200 pt-1.5">עלות כוללת (landed)</dt>
          <dd className="border-t border-stone-200 pt-1.5">
            <Money value={result.landed} />
          </dd>
        </div>
      </dl>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <PriceBox label="רווח 50%" value={result.price50} testId="price-50" />
        <PriceBox label="רווח 60%" value={result.price60} testId="price-60" />
        <PriceBox label="רווח 70%" value={result.price70} testId="price-70" highlight />
      </div>
      <p className="mt-2 text-xs text-stone-500">
        תעריף מדפסת: <span className="num">₪{formatNumber(result.printerRate, 5)}</span> לשעה (מחיר = עלות ÷ (1 − רווח))
      </p>
    </section>
  )
}

function PriceBox({ label, value, highlight, testId }: { label: string; value: number; highlight?: boolean; testId: string }) {
  return (
    <div
      data-testid={testId}
      className={`rounded-lg px-2 py-2 ${highlight ? 'bg-accent text-white ring-2 ring-accent/30' : 'bg-stone-100 text-stone-800'}`}
    >
      <div className={`text-xs ${highlight ? 'text-white/85' : 'text-stone-500'}`}>{label}</div>
      <div className="text-base font-bold sm:text-lg">
        <Money value={value} />
      </div>
    </div>
  )
}
