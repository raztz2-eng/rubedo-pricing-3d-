import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AppSettings } from '../lib/bid'
import type { DriveStore } from '../lib/drive/types'
import { errorMessage } from '../lib/errors'
import { useApp } from '../state/AppContext'
import { ErrorBox, Notice, Spinner } from './ui'

export function NotConfiguredNotice() {
  return (
    <Notice tone="warn">
      <p className="font-semibold">האפליקציה עדיין לא מחוברת ל-Google.</p>
      <p className="mt-1">
        חסר המשתנה <code dir="ltr">VITE_GOOGLE_CLIENT_ID</code> (וגם <code dir="ltr">VITE_GOOGLE_API_KEY</code>,{' '}
        <code dir="ltr">VITE_GOOGLE_APP_ID</code>). יש להגדיר אותם בקובץ <code dir="ltr">.env.local</code> או בהגדרות
        הפרויקט ב-Vercel ולבנות מחדש.
      </p>
      <p className="mt-1">
        לצפייה בממשק בלי Google: <a className="text-accent underline" href="?demo=1">מצב הדגמה</a>.
      </p>
    </Notice>
  )
}

export interface DriveContext {
  drive: DriveStore
  folderId: string
  settings: AppSettings
}

/**
 * Renders children only when: Google is configured, the user is signed in, the models folder is chosen,
 * and settings loaded. Otherwise shows what is missing, in Hebrew.
 */
export function RequireDrive({ children }: { children: (ctx: DriveContext) => ReactNode }) {
  const { services, signedIn, signIn, folderId, settings, settingsLoading, settingsError, reloadSettings } = useApp()
  const [error, setError] = useState<string | null>(null)

  if (services.mode === 'unconfigured' || !services.drive) return <NotConfiguredNotice />

  if (!signedIn) {
    return (
      <div className="card flex flex-col items-start gap-3">
        <p>כדי לעבוד עם הדגמים יש להתחבר לחשבון Google (גישה רק לקבצים שהאפליקציה יוצרת).</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={async () => {
            setError(null)
            try {
              await signIn()
            } catch (e) {
              setError(errorMessage(e, 'ההתחברות ל-Google נכשלה.'))
            }
          }}
        >
          התחברות עם Google
        </button>
        {error && <ErrorBox>{error}</ErrorBox>}
      </div>
    )
  }

  if (!folderId) {
    return (
      <div className="card flex flex-col items-start gap-3">
        <p>עדיין לא נבחרה תיקיית הדגמים ב-Drive. בחרו אותה פעם אחת בהגדרות (3d › models).</p>
        <Link to="/settings" className="btn btn-primary">
          להגדרות
        </Link>
      </div>
    )
  }

  if (settingsError) return <ErrorBox onRetry={reloadSettings}>{settingsError}</ErrorBox>
  if (settingsLoading || !settings) return <Spinner label="טוען הגדרות…" />

  return <>{children({ drive: services.drive, folderId, settings })}</>
}
