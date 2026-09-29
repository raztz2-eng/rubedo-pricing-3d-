import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { LineItemsEditor } from '../components/LineItemsEditor'
import { PartsEditor } from '../components/PartsEditor'
import { PricePanel } from '../components/PricePanel'
import { RequireDrive, type DriveContext } from '../components/RequireDrive'
import { BlobImage, Dialog, ErrorBox, Field, Money, Spinner } from '../components/ui'
import type { Bid } from '../lib/bid'
import {
  applySlicedFile,
  bidToDraft,
  canSave,
  draftToContent,
  draftToPricingInput,
  emptyDraft,
  emptyPart,
  filesToUpload,
  invalidFields,
  newKey,
  type BidDraft,
  type FileDraft,
} from '../lib/bidForm'
import {
  checkName,
  loadBid,
  newSaveSession,
  saveNewBid,
  updateBid,
  type NameCheck,
  type SaveSession,
} from '../lib/drive/bidRepository'
import { errorMessage, logError } from '../lib/errors'
import { computePrice, isValidResult, type PricingSettings } from '../lib/pricing'
import { parseSlicedThreeMF } from '../lib/threemf'

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MODEL_EXT = /\.(stl|3mf|step|stp)$/i

export function NewModelPage() {
  return <RequireDrive>{(ctx) => <BidForm ctx={ctx} />}</RequireDrive>
}

export function EditModelPage() {
  const { id = '' } = useParams()
  return <RequireDrive>{(ctx) => <EditLoader ctx={ctx} folderId={id} />}</RequireDrive>
}

function EditLoader({ ctx, folderId }: { ctx: DriveContext; folderId: string }) {
  const [bid, setBid] = useState<Bid | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    loadBid(ctx.drive, folderId)
      .then((r) => !cancelled && setBid(r.bid))
      .catch((e: unknown) => {
        logError('load bid for edit', e)
        if (!cancelled) setError(errorMessage(e, 'טעינת הדגם נכשלה.'))
      })
    return () => {
      cancelled = true
    }
  }, [ctx.drive, folderId, tick])

  if (error) return <ErrorBox onRetry={() => setTick((t) => t + 1)}>{error}</ErrorBox>
  if (!bid) return <Spinner label="טוען דגם…" />
  return <BidForm ctx={ctx} existing={{ folderId, bid }} />
}

function BidForm({ ctx, existing }: { ctx: DriveContext; existing?: { folderId: string; bid: Bid } }) {
  const { drive, folderId: modelsFolderId, settings } = ctx
  const navigate = useNavigate()
  const [draft, setDraft] = useState<BidDraft>(() => (existing ? bidToDraft(existing.bid) : emptyDraft(settings.materials)))
  // New bids use current Settings; an existing bid keeps its snapshot unless the user recalculates.
  const [snapshot, setSnapshot] = useState<PricingSettings>(() => existing?.bid.settingsSnapshot ?? settings.pricing)
  const [sliceError, setSliceError] = useState<string | null>(null)
  const [parsing, setParsing] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<NameCheck | null>(null)
  const sessionRef = useRef<SaveSession>(newSaveSession())
  const folderNameRef = useRef<string | null>(null)
  // True after a failed save that already created the model folder: the name is locked until the retry succeeds.
  const [nameLocked, setNameLocked] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const effectiveSnapshot = existing ? snapshot : settings.pricing
  const result = useMemo(() => computePrice(draftToPricingInput(draft), effectiveSnapshot), [draft, effectiveSnapshot])
  const invalid = invalidFields(draft)
  const saveAllowed = canSave(draft) && isValidResult(result)

  const set = <K extends keyof BidDraft>(key: K, value: BidDraft[K]) => setDraft((d) => ({ ...d, [key]: value }))

  const materialOptions = useMemo(() => {
    const names = settings.materials.map((m) => m.name)
    if (draft.materialName && !names.includes(draft.materialName)) names.push(draft.materialName)
    return names
  }, [settings.materials, draft.materialName])

  const onMaterialChange = (name: string) => {
    const m = settings.materials.find((x) => x.name === name)
    setDraft((d) => ({ ...d, materialName: name, pricePerKg: m ? String(m.pricePerKg) : d.pricePerKg }))
  }

  const onSlicedFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setSliceError(null)
    setParsing(true)
    try {
      const info = await parseSlicedThreeMF(file)
      setDraft((d) => applySlicedFile(d, info, { name: file.name, blob: file }, settings.materials))
    } catch (err) {
      logError('parse sliced file', err)
      setSliceError(errorMessage(err, 'לא ניתן לקרוא את הקובץ.'))
    } finally {
      setParsing(false)
    }
  }

  const addFiles = (list: FileList | null, kind: 'image' | 'model') => {
    if (!list) return
    setFileError(null)
    const accepted: FileDraft[] = []
    const rejected: string[] = []
    for (const f of Array.from(list)) {
      const ok = kind === 'image' ? IMAGE_TYPES.includes(f.type) : MODEL_EXT.test(f.name)
      if (!ok) {
        rejected.push(f.name)
        continue
      }
      accepted.push({
        key: newKey(kind),
        name: f.name,
        kind,
        mimeType: f.type || 'application/octet-stream',
        blob: f,
        origin: 'user',
        include: true,
      })
    }
    if (rejected.length > 0) {
      setFileError(
        `${kind === 'image' ? 'אפשר לצרף רק תמונות jpg / png / webp' : 'אפשר לצרף רק קבצי stl / 3mf / step'}. לא צורפו: ${rejected.join(', ')}`,
      )
    }
    if (accepted.length > 0) setDraft((d) => ({ ...d, files: [...d.files, ...accepted] }))
  }

  const saveNew = async (folderName: string, d: BidDraft) => {
    folderNameRef.current = folderName
    const content = draftToContent(d, effectiveSnapshot, computePrice(draftToPricingInput(d), effectiveSnapshot))
    const saved = await saveNewBid(drive, modelsFolderId, { folderName, content, files: filesToUpload(d) }, sessionRef.current)
    navigate(`/model/${encodeURIComponent(saved.folderId)}`)
  }

  const run = async (fn: () => Promise<void>) => {
    setSaving(true)
    setSaveError(null)
    try {
      await fn()
    } catch (e) {
      logError('save bid', e)
      if (!existing && sessionRef.current.folderId) setNameLocked(true)
      setSaveError(`${errorMessage(e, 'השמירה נכשלה.')} הנתונים בטופס נשמרו — אפשר ללחוץ שוב על "שמירה" כדי להמשיך מאותה נקודה.`)
    } finally {
      setSaving(false)
    }
  }

  const onSave = () => {
    if (!saveAllowed || saving) return
    setRenameError(null)
    void run(async () => {
      if (existing) {
        // Renaming must not collide with another bid (nothing is ever overwritten).
        if (draft.name.trim().toLocaleLowerCase() !== existing.bid.name.trim().toLocaleLowerCase()) {
          const check = await checkName(drive, modelsFolderId, draft.name, existing.folderId)
          if (check.taken) {
            setRenameError(`כבר קיים דגם אחר בשם „${draft.name.trim()}”. בחרו שם אחר — שום הצעה לא נדרסה.`)
            nameInputRef.current?.focus()
            return
          }
        }
        const content = draftToContent(draft, snapshot, result)
        await updateBid(
          drive,
          modelsFolderId,
          { folderId: existing.folderId, existing: existing.bid, content, newFiles: filesToUpload(draft) },
          sessionRef.current,
        )
        navigate(`/model/${encodeURIComponent(existing.folderId)}`)
        return
      }
      // A retry after a partial failure reuses the folder that was already created.
      if (folderNameRef.current && sessionRef.current.folderId) {
        await saveNew(folderNameRef.current, draft)
        return
      }
      const check = await checkName(drive, modelsFolderId, draft.name)
      if (check.taken) {
        setConflict(check)
        return
      }
      await saveNew(draft.name.trim(), draft)
    })
  }

  const saveAsRevision = () => {
    if (!conflict) return
    const { folderName, revision } = conflict.nextRevision
    const d = { ...draft, revision }
    setDraft(d)
    setConflict(null)
    void run(() => saveNew(folderName, d))
  }

  const chooseAnotherName = () => {
    setConflict(null)
    nameInputRef.current?.focus()
    nameInputRef.current?.select()
  }

  const plateFiles = draft.files.filter((f) => f.origin === 'plate')
  const userImages = draft.files.filter((f) => f.origin === 'user' && f.kind === 'image')
  const otherFiles = draft.files.filter((f) => f.kind !== 'image')

  return (
    <div className="pb-24">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">{existing ? `עריכת ${existing.bid.name}` : 'דגם חדש'}</h1>
        {existing && (
          <Link to={`/model/${encodeURIComponent(existing.folderId)}`} className="btn btn-ghost">
            ביטול
          </Link>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          <section className="card flex flex-col gap-3" aria-label="פרטי הדגם">
            <h2 className="section-title">פרטי הדגם</h2>
            <Field
              label="שם"
              required
              value={draft.name}
              onChange={(v) => {
                setRenameError(null)
                set('name', v)
              }}
              inputRef={nameInputRef}
              disabled={nameLocked}
              hint={
                nameLocked
                  ? 'השם נעול: תיקיית הדגם כבר נוצרה ב-Drive בניסיון השמירה הקודם. לחצו „שמירה” כדי להשלים את השמירה באותה תיקייה.'
                  : undefined
              }
            />
            {renameError && <ErrorBox>{renameError}</ErrorBox>}
            <div className="flex flex-col gap-1">
              <label htmlFor="desc">תיאור</label>
              <textarea id="desc" rows={3} value={draft.description} onChange={(e) => set('description', e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Field label="גרסה" value={draft.revision} onChange={(v) => set('revision', v)} />
              <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor="material">חומר</label>
                <select id="material" value={draft.materialName} onChange={(e) => onMaterialChange(e.target.value)}>
                  {materialOptions.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <Field
                className="col-span-2 sm:col-span-1"
                label="מחיר חומר"
                type="number"
                suffix="₪/ק״ג"
                value={draft.pricePerKg}
                onChange={(v) => set('pricePerKg', v)}
              />
            </div>
          </section>

          <section className="card flex flex-col gap-3" aria-label="חלקים">
            <h2 className="section-title">חלקים</h2>
            <div className="flex flex-wrap gap-2">
              <label className="btn btn-primary cursor-pointer text-white">
                {parsing ? 'קורא קובץ…' : 'העלאת קובץ פרוס ‎.3mf'}
                <input
                  type="file"
                  accept=".3mf"
                  className="sr-only"
                  aria-label="העלאת קובץ פרוס"
                  onChange={onSlicedFile}
                  disabled={parsing}
                />
              </label>
              <button type="button" className="btn btn-secondary" onClick={() => set('parts', [...draft.parts, emptyPart()])}>
                + הוספת חלק ידנית
              </button>
            </div>
            {sliceError && <ErrorBox>{sliceError}</ErrorBox>}
            <PartsEditor parts={draft.parts} onChange={(parts) => set('parts', parts)} />
            {plateFiles.length > 0 && (
              <div className="flex flex-col gap-2">
                {plateFiles.map((f) => (
                  <label key={f.key} className="flex items-center gap-3 rounded-lg bg-stone-50 p-2 font-normal">
                    <input
                      type="checkbox"
                      checked={f.include}
                      onChange={(e) =>
                        set(
                          'files',
                          draft.files.map((x) => (x.key === f.key ? { ...x, include: e.target.checked } : x)),
                        )
                      }
                    />
                    <BlobImage blob={f.blob} alt={`תמונת פלטה ${f.plateIndex ?? ''}`} className="h-14 w-14 rounded object-contain" />
                    <span>להשתמש בתמונת הפלטה {f.plateIndex} כתמונת הדגם</span>
                  </label>
                ))}
              </div>
            )}
          </section>

          <section className="card" aria-label="עבודה">
            <h2 className="section-title">עבודה</h2>
            <Field label="זמן עבודה" type="number" suffix="דקות" value={draft.laborMinutes} onChange={(v) => set('laborMinutes', v)} />
          </section>

          <section className="card" aria-label="חומרה">
            <h2 className="section-title">חומרה (רכיבים שנקנו)</h2>
            <LineItemsEditor lines={draft.hardware} onChange={(l) => set('hardware', l)} addLabel="הוספת רכיב" itemLabel="רכיב" />
          </section>

          <section className="card flex flex-col gap-3" aria-label="אריזה ומשלוח">
            <label className="flex items-center gap-2 text-base font-bold text-stone-900">
              <input type="checkbox" checked={draft.hasShipping} onChange={(e) => set('hasShipping', e.target.checked)} />
              כולל אריזה ומשלוח
            </label>
            {draft.hasShipping && (
              <div className="flex flex-col gap-3" data-testid="packaging-section">
                <LineItemsEditor lines={draft.packaging} onChange={(l) => set('packaging', l)} addLabel="הוספת פריט אריזה" itemLabel="פריט אריזה" />
                <Field label="עלות משלוח" type="number" suffix="₪" value={draft.shippingCost} onChange={(v) => set('shippingCost', v)} />
              </div>
            )}
          </section>

          <section className="card flex flex-col gap-3" aria-label="קבצים ותמונות">
            <h2 className="section-title">תמונות וקבצים</h2>
            <div className="flex flex-wrap gap-2">
              <label className="btn btn-secondary cursor-pointer">
                + תמונות
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  className="sr-only"
                  aria-label="הוספת תמונות"
                  onChange={(e) => {
                    addFiles(e.target.files, 'image')
                    e.target.value = ''
                  }}
                />
              </label>
              <label className="btn btn-secondary cursor-pointer">
                + קבצי דגם (stl / 3mf / step)
                <input
                  type="file"
                  accept=".stl,.3mf,.step,.stp"
                  multiple
                  className="sr-only"
                  aria-label="הוספת קבצי דגם"
                  onChange={(e) => {
                    addFiles(e.target.files, 'model')
                    e.target.value = ''
                  }}
                />
              </label>
            </div>
            {fileError && <ErrorBox>{fileError}</ErrorBox>}
            {userImages.length > 0 && (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {userImages.map((f) => (
                  <div key={f.key} className="relative">
                    <BlobImage blob={f.blob} alt={f.name} className="aspect-square w-full rounded-lg object-cover" />
                    <button
                      type="button"
                      className="absolute end-1 top-1 rounded-full bg-white/90 px-2 text-sm shadow"
                      aria-label={`הסרת ${f.name}`}
                      onClick={() => set('files', draft.files.filter((x) => x.key !== f.key))}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            {otherFiles.length > 0 && (
              <ul className="flex flex-col gap-1 text-sm">
                {otherFiles.map((f) => (
                  <li key={f.key} className="flex items-center justify-between gap-2 rounded bg-stone-50 px-2 py-1">
                    <span className="truncate" dir="ltr">
                      {f.name}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-stone-500">{f.kind === 'sliced' ? 'קובץ פרוס' : 'קובץ דגם'}</span>
                      <button
                        type="button"
                        className="text-red-700"
                        aria-label={`הסרת ${f.name}`}
                        onClick={() => set('files', draft.files.filter((x) => x.key !== f.key))}
                      >
                        ×
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {draft.existingFiles.length > 0 && (
              <div className="text-sm">
                <p className="mb-1 text-stone-600">קבצים שכבר שמורים עם הדגם:</p>
                <ul className="flex flex-col gap-1">
                  {draft.existingFiles.map((f) => (
                    <li key={f.id} className="truncate rounded bg-stone-50 px-2 py-1" dir="ltr">
                      {f.name}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-3 lg:sticky lg:top-20">
          <PricePanel result={result} />
          {existing && (
            <div className="card flex flex-col gap-2 text-sm">
              <p className="text-stone-600">המחיר מחושב לפי ההגדרות שנשמרו עם ההצעה.</p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setSnapshot({ ...settings.pricing })}
                disabled={JSON.stringify(snapshot) === JSON.stringify(settings.pricing)}
              >
                חישוב מחדש לפי ההגדרות הנוכחיות
              </button>
            </div>
          )}
          {invalid.length > 0 && <ErrorBox>ערכים לא תקינים: {invalid.join(', ')}</ErrorBox>}
        </aside>
      </div>

      {saveError && (
        <div className="mt-4">
          <ErrorBox>{saveError}</ErrorBox>
        </div>
      )}

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-stone-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-stone-500">מחיר (70%)</div>
            <div className="text-lg font-bold text-accent" data-testid="sticky-price-70">
              <Money value={result.price70} />
            </div>
          </div>
          {!saveAllowed && !saving && <span className="hidden text-xs text-stone-500 sm:block">נדרש שם וחלק אחד לפחות עם משקל או זמן</span>}
          <button type="button" className="btn btn-primary min-w-28" onClick={onSave} disabled={!saveAllowed || saving}>
            {saving ? 'שומר…' : 'שמירה'}
          </button>
        </div>
      </div>

      {conflict && (
        <Dialog title="השם כבר קיים" onClose={() => setConflict(null)}>
          <p className="mb-4 text-sm text-stone-700">
            כבר קיים דגם בשם „{draft.name.trim()}”. ההצעה הקיימת לא תידרס.
          </p>
          <div className="flex flex-col gap-2">
            <button type="button" className="btn btn-primary" onClick={saveAsRevision}>
              שמירה כגרסה חדשה ({conflict.nextRevision.revision})
            </button>
            <button type="button" className="btn btn-secondary" onClick={chooseAnotherName}>
              בחירת שם אחר
            </button>
          </div>
        </Dialog>
      )}
    </div>
  )
}
