import { useState } from 'react'
import { NotConfiguredNotice, RequireDrive, type DriveContext } from '../components/RequireDrive'
import { ErrorBox, Field } from '../components/ui'
import type { AppSettings } from '../lib/bid'
import { errorMessage, logError } from '../lib/errors'
import { formatNumber, isValidAmount, parseNumber } from '../lib/format'
import { computePrinterRate, DEFAULT_PRICING_SETTINGS, type PricingSettings } from '../lib/pricing'
import { useApp } from '../state/AppContext'

const PRICING_FIELDS: { key: keyof PricingSettings; label: string; suffix?: string }[] = [
  { key: 'laborRate', label: 'תעריף עבודה', suffix: '₪/שעה' },
  { key: 'efficiency', label: 'מקדם בזבוז פילמנט', suffix: '×' },
  { key: 'printerCost', label: 'מחיר מדפסת', suffix: '₪' },
  { key: 'upgrades', label: 'שדרוגים', suffix: '₪' },
  { key: 'maintenancePerYear', label: 'תחזוקה לשנה', suffix: '₪' },
  { key: 'lifeYears', label: 'אורך חיים', suffix: 'שנים' },
  { key: 'uptime', label: 'ניצולת (0–1)' },
  { key: 'powerW', label: 'צריכת חשמל', suffix: 'וואט' },
  { key: 'kwhPrice', label: 'מחיר קוט״ש', suffix: '₪' },
  { key: 'buffer', label: 'מקדם ביטחון', suffix: '×' },
]

export function SettingsPage() {
  const { services, signedIn, folderId, pickFolder } = useApp()
  const [pickError, setPickError] = useState<string | null>(null)

  if (services.mode === 'unconfigured') return <NotConfiguredNotice />
  if (!signedIn) return <RequireDrive>{() => null}</RequireDrive>

  const onPick = async () => {
    setPickError(null)
    try {
      await pickFolder()
    } catch (e) {
      logError('pick folder', e)
      setPickError(errorMessage(e, 'בחירת התיקייה נכשלה.'))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">הגדרות</h1>
      <section className="card flex flex-col gap-2" aria-label="תיקיית הדגמים">
        <h2 className="section-title">תיקיית הדגמים ב-Drive</h2>
        {folderId ? (
          <p className="text-sm text-stone-600">
            נבחרה תיקייה.{' '}
            <a className="text-accent underline" href={services.drive?.folderUrl(folderId)} target="_blank" rel="noreferrer">
              פתיחה ב-Drive
            </a>
          </p>
        ) : (
          <p className="text-sm text-stone-600">בחרו פעם אחת את התיקייה ‎3d › models‎. כל הדגמים וקובץ ההגדרות יישמרו בה.</p>
        )}
        <div>
          <button type="button" className={`btn ${folderId ? 'btn-secondary' : 'btn-primary'}`} onClick={onPick}>
            {folderId ? 'החלפת תיקייה' : 'בחירת תיקיית דגמים'}
          </button>
        </div>
        {pickError && <ErrorBox>{pickError}</ErrorBox>}
      </section>
      {folderId && <RequireDrive>{(ctx) => <SettingsForm key={folderId} ctx={ctx} />}</RequireDrive>}
    </div>
  )
}

interface MaterialDraft {
  key: number
  name: string
  pricePerKg: string
}

function SettingsForm({ ctx }: { ctx: DriveContext }) {
  const { saveSettings } = useApp()
  const [pricing, setPricing] = useState<Record<keyof PricingSettings, string>>(
    () => Object.fromEntries(Object.entries(ctx.settings.pricing).map(([k, v]) => [k, String(v)])) as Record<keyof PricingSettings, string>,
  )
  const [materials, setMaterials] = useState<MaterialDraft[]>(() =>
    ctx.settings.materials.map((m, i) => ({ key: i, name: m.name, pricePerKg: String(m.pricePerKg) })),
  )
  const [nextKey, setNextKey] = useState(ctx.settings.materials.length)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const parsed = Object.fromEntries(Object.entries(pricing).map(([k, v]) => [k, parseNumber(v)])) as unknown as PricingSettings
  // Same rule as the bid form (isValidAmount: a number, not negative) + settings may not be left empty.
  const badPricing = PRICING_FIELDS.filter((f) => pricing[f.key].trim() === '' || !isValidAmount(pricing[f.key]))
  const badMaterials = materials.filter((m) => m.name.trim() === '' || m.pricePerKg.trim() === '' || !isValidAmount(m.pricePerKg))
  const rate = computePrinterRate(parsed)
  const rateValid = Number.isFinite(rate) && rate >= 0
  const invalidLabels = [
    ...badPricing.map((f) => f.label),
    ...badMaterials.map((m) => `חומר ${materials.indexOf(m) + 1}`),
    ...(badPricing.length === 0 && !rateValid ? ['תעריף מדפסת (בדקו אורך חיים וניצולת)'] : []),
  ]
  const valid = invalidLabels.length === 0 && materials.length > 0

  const onSave = async () => {
    if (!valid) return
    setSaving(true)
    setError(null)
    setSaved(false)
    const next: AppSettings = {
      schemaVersion: 1,
      pricing: parsed,
      materials: materials.map((m) => ({ name: m.name.trim(), pricePerKg: parseNumber(m.pricePerKg) })),
    }
    try {
      await saveSettings(next)
      setSaved(true)
    } catch (e) {
      logError('save settings', e)
      setError(errorMessage(e, 'שמירת ההגדרות נכשלה.'))
    } finally {
      setSaving(false)
    }
  }

  const touch = () => setSaved(false)

  return (
    <>
      <section className="card flex flex-col gap-3" aria-label="הגדרות תמחור">
        <h2 className="section-title">תמחור</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {PRICING_FIELDS.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              type="number"
              suffix={f.suffix}
              value={pricing[f.key]}
              onChange={(v) => {
                touch()
                setPricing((p) => ({ ...p, [f.key]: v }))
              }}
            />
          ))}
        </div>
        <p className="rounded-lg bg-stone-100 px-3 py-2 text-sm" data-testid="printer-rate">
          תעריף מדפסת מחושב: <span className="num font-bold">₪{formatNumber(rate, 5)}</span> לשעה
        </p>
        <div>
          <button
            type="button"
            className="btn btn-ghost px-2 text-sm"
            onClick={() => {
              touch()
              setPricing(
                Object.fromEntries(Object.entries(DEFAULT_PRICING_SETTINGS).map(([k, v]) => [k, String(v)])) as Record<
                  keyof PricingSettings,
                  string
                >,
              )
            }}
          >
            איפוס לברירות המחדל
          </button>
        </div>
      </section>

      <section className="card flex flex-col gap-3" aria-label="חומרים">
        <h2 className="section-title">חומרים ומחירים</h2>
        {materials.map((m, i) => (
          <div key={m.key} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <Field
              label={`חומר ${i + 1}`}
              value={m.name}
              onChange={(v) => {
                touch()
                setMaterials((ms) => ms.map((x) => (x.key === m.key ? { ...x, name: v } : x)))
              }}
            />
            <Field
              label="מחיר"
              type="number"
              suffix="₪/ק״ג"
              value={m.pricePerKg}
              onChange={(v) => {
                touch()
                setMaterials((ms) => ms.map((x) => (x.key === m.key ? { ...x, pricePerKg: v } : x)))
              }}
            />
            <button
              type="button"
              className="btn btn-ghost text-red-700"
              aria-label={`הסרת חומר ${i + 1}`}
              disabled={materials.length === 1}
              onClick={() => {
                touch()
                setMaterials((ms) => ms.filter((x) => x.key !== m.key))
              }}
            >
              הסרה
            </button>
          </div>
        ))}
        <div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              touch()
              setMaterials((ms) => [...ms, { key: nextKey, name: '', pricePerKg: '85' }])
              setNextKey((k) => k + 1)
            }}
          >
            + הוספת חומר
          </button>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={!valid || saving}>
          {saving ? 'שומר…' : 'שמירת הגדרות'}
        </button>
        {saved && <span className="text-sm text-emerald-700">נשמר. ההגדרות חלות על הצעות חדשות בלבד.</span>}
        {!valid && (
          <span role="alert" className="text-sm text-red-700" data-testid="settings-invalid">
            ערכים לא תקינים (ריקים, לא מספר או שליליים): {invalidLabels.join(', ')}
          </span>
        )}
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
    </>
  )
}
