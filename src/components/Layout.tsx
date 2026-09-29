import { useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { errorMessage } from '../lib/errors'
import { useApp } from '../state/AppContext'

export function Layout() {
  const { services, signedIn, signIn, signOut } = useApp()
  const [authError, setAuthError] = useState<string | null>(null)

  const onSignIn = async () => {
    setAuthError(null)
    try {
      await signIn()
    } catch (e) {
      setAuthError(errorMessage(e, 'ההתחברות ל-Google נכשלה.'))
    }
  }

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
              (signedIn ? (
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
        {authError && (
          <div role="alert" className="bg-red-50 px-4 py-2 text-center text-sm text-red-800">
            {authError}
          </div>
        )}
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}
