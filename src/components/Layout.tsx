import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { errorMessage } from '../lib/errors'
import { useApp } from '../state/AppContext'

export function Layout() {
  const { services, signedIn, needsReconnect, authChecking, authError: sessionError, settingsJustCreated, settingsCreatedFrom, dismissSettingsCreated, signIn, retrySession, signOut } =
    useApp()
  const [clickError, setClickError] = useState<string | null>(null)
  const authError = clickError ?? sessionError

  // signIn() runs first thing in the click: signed out → full redirect; "needs reconnect" → popup opened
  // synchronously (mobile Safari blocks popups opened after an await), so this page and its form stay mounted.
  const onSignIn = () => {
    const pending = signIn()
    setClickError(null)
    pending.catch((e: unknown) => setClickError(errorMessage(e, 'ההתחברות ל-Google נכשלה.')))
  }

  const onContinue = () => {
    setClickError(null)
    retrySession().catch((e: unknown) => setClickError(errorMessage(e, 'החיבור עדיין לא חודש. התחברו בחלון שנפתח ונסו שוב.')))
  }

  // Back from the popup: coming back to this tab retries the session quietly.
  useEffect(() => {
    if (!needsReconnect) return
    const onFocus = () => {
      retrySession().catch(() => {
        /* still disconnected — the banner stays; "המשך" shows the reason */
      })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [needsReconnect, retrySession])

  const navCls = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-2 py-1 text-sm ${isActive ? 'bg-stone-100 font-semibold text-stone-900' : 'text-stone-600 hover:text-stone-900'}`

  return (
    <div className="min-h-dvh">
      {services.mode === 'demo' && (
        <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900">
          מצב הדגמה — הנתונים נשמרים בזיכרון הדפדפן בלבד ונמחקים ברענון. אין חיבור ל-Google Drive.
        </div>
      )}
      <header className="sticky top-0 z-40 border-b border-stone-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <Link to="/" className="text-lg font-extrabold tracking-tight" dir="ltr">
            RUBEDO<span className="text-accent">.3D</span>
          </Link>
          <nav className="flex items-center gap-1" aria-label="ניווט ראשי">
            <NavLink to="/library" className={navCls}>
              ספרייה
            </NavLink>
            <NavLink to="/new" className={navCls}>
              דגם חדש
            </NavLink>
            <NavLink to="/settings" className={navCls}>
              הגדרות
            </NavLink>
          </nav>
          <div className="ms-auto flex items-center gap-2 text-sm">
            {services.mode === 'google' &&
              (authChecking ? (
                <span className="text-stone-500">בודק חיבור…</span>
              ) : needsReconnect ? (
                <span className="flex items-center gap-1 text-amber-800">
                  <span className="h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />
                  נדרש חיבור מחדש
                </span>
              ) : signedIn ? (
                <>
                  <span className="flex items-center gap-1 text-stone-600">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
                    מחובר ל-Google
                  </span>
                  <button type="button" className="btn btn-ghost px-2 py-1" onClick={signOut}>
                    התנתקות
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-secondary px-3 py-1" onClick={onSignIn}>
                  התחברות עם Google
                </button>
              ))}
            {services.mode === 'demo' && <span className="text-stone-500">הדגמה</span>}
          </div>
        </div>
        {needsReconnect && (
          <div role="alert" className="flex flex-wrap items-center justify-center gap-3 bg-amber-50 px-4 py-2 text-sm text-amber-900">
            <span>
              החיבור ל-Google פג — לחצו „התחבר מחדש”: ייפתח חלון התחברות, והטופס כאן נשאר פתוח עם כל הנתונים. אחרי ההתחברות
              חזרו לכאן או לחצו „המשך”.
            </span>
            <button type="button" className="btn btn-primary px-3 py-1" onClick={onSignIn}>
              התחבר מחדש
            </button>
            <button type="button" className="btn btn-secondary px-3 py-1" onClick={onContinue}>
              המשך
            </button>
          </div>
        )}
        {authError && (
          <div role="alert" className="bg-red-50 px-4 py-2 text-center text-sm text-red-800">
            {authError}
          </div>
        )}
        {settingsJustCreated && (
          <div className="flex flex-wrap items-center justify-center gap-3 bg-sky-50 px-4 py-2 text-sm text-sky-900" data-testid="settings-created-notice">
            {settingsCreatedFrom === 'copied' ? (
              <span>
                נוצר קובץ הגדרות חדש של האפליקציה עם הערכים מקובץ ההגדרות הקודם (הקובץ הקודם לא שונה). אם זו לא התיקייה הנכונה (3D ›
                models), החליפו אותה בעמוד ההגדרות.
              </span>
            ) : (
              <span>
                בתיקיית הדגמים הזו לא היה קובץ הגדרות, ולכן נוצר חדש עם ערכי ברירת המחדל. אם זו לא התיקייה הנכונה (3D › models),
                החליפו אותה בעמוד ההגדרות.
              </span>
            )}
            <button type="button" className="btn btn-secondary px-3 py-1" onClick={dismissSettingsCreated}>
              הבנתי
            </button>
          </div>
        )}
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}
