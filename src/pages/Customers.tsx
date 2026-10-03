import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { DriveImage } from '../components/DriveImage'
import { RequireDrive, type DriveContext } from '../components/RequireDrive'
import { Dialog, ErrorBox, Field, Money, Notice, Spinner } from '../components/ui'
import { isArchived, isPriced, type IndexEntry, type QuoteSummary } from '../lib/bid'
import { customerProblems, matchesCustomer, quotesForCustomer, type Customer, type CustomerInput } from '../lib/customers'
import { loadQuoteHistory, type QuoteHistory } from '../lib/drive/bidRepository'
import { addCustomer, loadCustomers, setCustomerHidden, updateCustomer } from '../lib/drive/customerStore'
import { errorMessage, logError } from '../lib/errors'
import { formatDate } from '../lib/format'
import { formatCustomerPrice } from '../lib/quote'

/** Customers list and customer page (brief v0.6 E4). Nothing is ever removed: a customer can only be hidden. */

export function CustomersPageRoute() {
  return <RequireDrive>{(ctx) => <CustomersPage ctx={ctx} />}</RequireDrive>
}

export function CustomerPageRoute() {
  const { id = '' } = useParams()
  return <RequireDrive>{(ctx) => <CustomerPage key={id} ctx={ctx} customerId={id} />}</RequireDrive>
}

/** File names inside Hebrew text, each isolated left-to-right. */
function FileNames({ names }: { names: readonly string[] }) {
  return (
    <>
      {names.map((n, i) => (
        <span key={n}>
          {i > 0 && ', '}
          <bdi dir="ltr">{n}</bdi>
        </span>
      ))}
    </>
  )
}

/** Customers + quote history of the current models folder; each loads (and fails) on its own. */
function useCustomersData(ctx: DriveContext) {
  const { drive, folderId } = ctx
  const [customers, setCustomers] = useState<Customer[] | null>(null)
  const [customersError, setCustomersError] = useState<string | null>(null)
  const [history, setHistory] = useState<QuoteHistory | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyBusy, setHistoryBusy] = useState(false)

  const loadList = useCallback(async () => {
    setCustomersError(null)
    try {
      setCustomers(await loadCustomers(drive, folderId))
    } catch (e) {
      logError('load customers', e)
      setCustomersError(errorMessage(e, 'טעינת רשימת הלקוחות נכשלה.'))
    }
  }, [drive, folderId])

  const loadHistory = useCallback(
    async (refresh: boolean) => {
      setHistoryError(null)
      setHistoryBusy(true)
      try {
        setHistory(await loadQuoteHistory(drive, folderId, { refresh }))
      } catch (e) {
        logError('load quote history', e)
        setHistoryError(errorMessage(e, 'טעינת היסטוריית ההצעות נכשלה.'))
      } finally {
        setHistoryBusy(false)
      }
    },
    [drive, folderId],
  )

  useEffect(() => {
    void loadList()
    void loadHistory(false)
  }, [loadList, loadHistory])

  return { customers, setCustomers, customersError, loadList, history, historyError, historyBusy, loadHistory }
}

// ---------- Customer form ----------

function CustomerForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Customer
  submitLabel: string
  onSubmit: (input: CustomerInput) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [email, setEmail] = useState(initial?.email ?? '')
  const [phone, setPhone] = useState(initial?.phone ?? '')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input: CustomerInput = { name, email, phone, notes }
  const problems = customerProblems(input)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setShowErrors(true)
    if (problems.length > 0 || saving) return
    setSaving(true)
    setError(null)
    try {
      await onSubmit(input)
    } catch (err) {
      logError('save customer', err)
      setError(errorMessage(err, 'שמירת הלקוח נכשלה.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="card flex flex-col gap-3" aria-label={submitLabel} onSubmit={(e) => void submit(e)} noValidate>
      <Field label="שם" required value={name} onChange={setName} />
      <Field label="מייל" required dir="ltr" inputMode="email" autoComplete="off" value={email} onChange={setEmail} />
      <Field label="טלפון (לא חובה)" dir="ltr" inputMode="tel" autoComplete="off" value={phone} onChange={setPhone} />
      <div className="flex flex-col gap-1">
        <label htmlFor="customer-notes">הערות (לא חובה)</label>
        <textarea id="customer-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {showErrors && problems.length > 0 && (
        <ErrorBox>
          <span className="flex flex-col">
            {problems.map((p) => (
              <span key={p}>{p}</span>
            ))}
          </span>
        </ErrorBox>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'שומר…' : submitLabel}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>
          ביטול
        </button>
      </div>
    </form>
  )
}

// ---------- List ----------

function CustomersPage({ ctx }: { ctx: DriveContext }) {
  const data = useCustomersData(ctx)
  const { customers, setCustomers, history } = data
  const [query, setQuery] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [adding, setAdding] = useState(false)

  const all = useMemo(() => customers ?? [], [customers])
  const hiddenCount = all.filter((c) => c.hidden).length
  const visible = useMemo(
    () =>
      all
        .filter((c) => (showHidden ? true : !c.hidden) && matchesCustomer(c, query))
        .sort((a, b) => a.name.localeCompare(b.name, 'he')),
    [all, showHidden, query],
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="me-auto text-2xl font-bold">לקוחות</h1>
        <button type="button" className="btn btn-secondary" onClick={() => void data.loadHistory(true)} disabled={data.historyBusy}>
          {data.historyBusy ? 'מרענן…' : 'רענון היסטוריה'}
        </button>
        {!adding && (
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)} disabled={customers === null}>
            + לקוח חדש
          </button>
        )}
      </div>

      {adding && (
        <CustomerForm
          submitLabel="הוספת לקוח"
          onCancel={() => setAdding(false)}
          onSubmit={async (input) => {
            const r = await addCustomer(ctx.drive, ctx.folderId, input)
            setCustomers(r.list)
            setAdding(false)
          }}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          className="min-w-0 flex-1"
          placeholder="חיפוש לפי שם או מייל…"
          aria-label="חיפוש לפי שם או מייל"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm font-normal">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          הצגת לקוחות מוסתרים (<span className="num">{hiddenCount}</span>)
        </label>
      </div>

      {data.customersError && <ErrorBox onRetry={() => void data.loadList()}>{data.customersError}</ErrorBox>}
      {data.historyError && (
        <ErrorBox onRetry={() => void data.loadHistory(true)}>
          {data.historyError} מספר ההצעות ותאריך ההצעה האחרונה לא מוצגים.
        </ErrorBox>
      )}
      {history && history.skippedQuotes.length > 0 && (
        <Notice tone="warn">
          לא ניתן היה לקרוא חלק מקובצי ההצעות: <FileNames names={history.skippedQuotes} /> — הם לא נספרים.
        </Notice>
      )}
      {customers === null && !data.customersError && <Spinner label="טוען לקוחות…" />}
      {customers !== null && visible.length === 0 && (
        <p className="py-8 text-center text-stone-500">{all.length === 0 ? 'אין עדיין לקוחות. לקוח חדש נוסף גם אוטומטית אחרי טיוטת הצעה ב-Gmail.' : 'לא נמצאו לקוחות.'}</p>
      )}
      {visible.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="רשימת הלקוחות">
          {visible.map((c) => {
            const quotes = history ? quotesForCustomer(history.quotes, c, all) : null
            return (
              <li key={c.id} className="card flex flex-wrap items-center gap-x-4 gap-y-1 py-3" data-testid="customer-row">
                <div className="me-auto min-w-0">
                  <Link to={`/customers/${encodeURIComponent(c.id)}`} className="font-semibold text-accent underline">
                    {c.name}
                  </Link>
                  {c.hidden && <span className="ms-2 rounded bg-stone-100 px-1.5 text-xs text-stone-500">מוסתר</span>}
                  <div className="truncate text-sm text-stone-600">
                    <bdi dir="ltr">{c.email}</bdi>
                  </div>
                </div>
                <div className="flex gap-4 text-sm text-stone-600">
                  <span>
                    הצעות:{' '}
                    <span className="num font-semibold" data-testid="customer-quote-count">
                      {quotes ? quotes.length : '—'}
                    </span>
                  </span>
                  <span>
                    הצעה אחרונה:{' '}
                    <span data-testid="customer-last-quote">{quotes ? (quotes[0] ? formatDate(quotes[0].date) : 'אין') : '—'}</span>
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ---------- Customer page ----------

function CustomerPage({ ctx, customerId }: { ctx: DriveContext; customerId: string }) {
  const navigate = useNavigate()
  const data = useCustomersData(ctx)
  const { customers, setCustomers, history } = data
  const [editing, setEditing] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [hideBusy, setHideBusy] = useState(false)
  const [hideError, setHideError] = useState<string | null>(null)

  if (data.customersError) return <ErrorBox onRetry={() => void data.loadList()}>{data.customersError}</ErrorBox>
  if (customers === null) return <Spinner label="טוען לקוח…" />
  const customer = customers.find((c) => c.id === customerId)
  if (!customer) {
    return (
      <ErrorBox>
        הלקוח לא נמצא ברשימת הלקוחות.{' '}
        <Link className="underline" to="/customers">
          לרשימת הלקוחות
        </Link>
      </ErrorBox>
    )
  }
  const quotes: QuoteSummary[] | null = history ? quotesForCustomer(history.quotes, customer, customers) : null

  const toggleHidden = async () => {
    setHideBusy(true)
    setHideError(null)
    try {
      const r = await setCustomerHidden(ctx.drive, ctx.folderId, customer.id, !customer.hidden)
      setCustomers(r.list)
    } catch (e) {
      logError('hide customer', e)
      setHideError(errorMessage(e, 'שמירת הלקוח נכשלה.'))
    } finally {
      setHideBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="me-auto min-w-0">
          <h1 className="text-2xl font-bold">{customer.name}</h1>
          <p className="text-sm text-stone-600">
            <bdi dir="ltr">{customer.email}</bdi>
          </p>
          {customer.phone && (
            <p className="text-sm text-stone-600">
              טלפון: <bdi dir="ltr">{customer.phone}</bdi>
            </p>
          )}
          {customer.hidden && <span className="mt-1 inline-block rounded bg-stone-100 px-1.5 text-xs text-stone-500">מוסתר</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={() => setChoosing(true)}>
            שליחת הצעה חדשה
          </button>
          {!editing && (
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>
              עריכת פרטי לקוח
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => void toggleHidden()} disabled={hideBusy}>
            {customer.hidden ? 'הצג שוב' : 'הסתר'}
          </button>
          <Link to="/customers" className="btn btn-ghost">
            לכל הלקוחות
          </Link>
        </div>
      </div>
      {hideError && <ErrorBox>{hideError}</ErrorBox>}
      {customer.notes && !editing && (
        <section className="card">
          <h2 className="section-title">הערות</h2>
          <p className="whitespace-pre-wrap text-stone-700">{customer.notes}</p>
        </section>
      )}
      {editing && (
        <CustomerForm
          initial={customer}
          submitLabel="שמירת פרטי לקוח"
          onCancel={() => setEditing(false)}
          onSubmit={async (input) => {
            const r = await updateCustomer(ctx.drive, ctx.folderId, customer.id, input)
            setCustomers(r.list)
            setEditing(false)
          }}
        />
      )}

      <section className="card flex flex-col gap-2" aria-label="הצעות שנשלחו">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="section-title">הצעות שנשלחו</h2>
          <button type="button" className="btn btn-ghost px-2 py-1 text-sm" onClick={() => void data.loadHistory(true)} disabled={data.historyBusy}>
            {data.historyBusy ? 'מרענן…' : 'רענון'}
          </button>
        </div>
        {data.historyError && <ErrorBox onRetry={() => void data.loadHistory(true)}>{data.historyError}</ErrorBox>}
        {history && history.skippedQuotes.length > 0 && (
          <Notice tone="warn">
            לא ניתן היה לקרוא חלק מקובצי ההצעות: <FileNames names={history.skippedQuotes} />
          </Notice>
        )}
        {quotes === null && !data.historyError && <Spinner label="טוען הצעות…" />}
        {quotes !== null && quotes.length === 0 && <p className="text-sm text-stone-500">עדיין לא נשלחו הצעות ללקוח הזה.</p>}
        {quotes !== null && quotes.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="הצעות ללקוח">
              <thead className="text-stone-500">
                <tr>
                  <th className="py-1 text-start font-medium">תאריך</th>
                  <th className="py-1 text-start font-medium">דגם</th>
                  <th className="py-1 text-start font-medium">מחיר שהוצג</th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((q) => (
                  <tr key={q.fileId} className="border-t border-stone-100" data-testid="customer-quote">
                    <td className="py-1.5">{formatDate(q.date)}</td>
                    <td className="py-1.5">
                      <Link className="text-accent underline" to={`/model/${encodeURIComponent(q.folderId)}`}>
                        {q.modelName}
                      </Link>
                    </td>
                    <td className="py-1.5">
                      <span className="num">{formatCustomerPrice(q.priceShown)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {choosing && (
        <ModelChooser
          ctx={ctx}
          entries={history?.entries ?? null}
          error={data.historyError}
          onRetry={() => void data.loadHistory(true)}
          onClose={() => setChoosing(false)}
          onChoose={(entry) =>
            navigate(`/model/${encodeURIComponent(entry.id)}/quote?customer=${encodeURIComponent(customer.id)}`)
          }
        />
      )}
    </div>
  )
}

/** "שליחת הצעה חדשה" → choose a priced model (search by name) → its quote screen, prefilled with the customer. */
function ModelChooser({
  ctx,
  entries,
  error,
  onRetry,
  onClose,
  onChoose,
}: {
  ctx: DriveContext
  entries: IndexEntry[] | null
  error: string | null
  onRetry: () => void
  onClose: () => void
  onChoose: (entry: IndexEntry) => void
}) {
  const [query, setQuery] = useState('')
  const priced = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    // v0.7 A3: archived models are not offered for a new quote (their past quotes stay on the customer page).
    return (entries ?? []).filter((e) => isPriced(e) && !isArchived(e) && (q === '' || e.name.toLocaleLowerCase().includes(q)))
  }, [entries, query])

  return (
    <Dialog title="בחירת דגם להצעה" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <input
          type="search"
          placeholder="חיפוש דגם לפי שם…"
          aria-label="חיפוש דגם לפי שם"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {error && <ErrorBox onRetry={onRetry}>{error}</ErrorBox>}
        {entries === null && !error && <Spinner label="טוען דגמים…" />}
        {entries !== null && priced.length === 0 && <p className="text-sm text-stone-500">לא נמצאו דגמים עם הצעת מחיר.</p>}
        <ul className="flex max-h-80 flex-col gap-1 overflow-auto" aria-label="דגמים עם הצעת מחיר">
          {priced.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-lg p-2 text-start hover:bg-stone-50"
                onClick={() => onChoose(e)}
              >
                <DriveImage drive={ctx.drive} fileId={e.coverFileId} alt="" size={120} className="h-10 w-10 shrink-0 rounded object-cover" />
                <span className="min-w-0 flex-1 truncate font-medium">{e.name}</span>
                {e.price70 !== undefined && <Money value={e.price70} className="text-sm text-stone-600" />}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          ביטול
        </button>
      </div>
    </Dialog>
  )
}
