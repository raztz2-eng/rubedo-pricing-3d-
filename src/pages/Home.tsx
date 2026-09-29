import { Link } from 'react-router-dom'
import { NotConfiguredNotice } from '../components/RequireDrive'
import { useApp } from '../state/AppContext'

export function Home() {
  const { services } = useApp()
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">תמחור הדפסות תלת-ממד</h1>
        <p className="mt-1 text-stone-600">הצעות מחיר לפי שיטת RUBEDO.3D, שמורות בתיקיית Google Drive שלך.</p>
      </div>
      {services.mode === 'unconfigured' && <NotConfiguredNotice />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          to="/library"
          className="card flex min-h-32 flex-col justify-center gap-1 text-center transition hover:border-stone-400 hover:shadow"
        >
          <span className="text-2xl font-bold">ספרייה</span>
          <span className="text-sm text-stone-500">כל הדגמים וההצעות השמורים</span>
        </Link>
        <Link
          to="/new"
          className="flex min-h-32 flex-col justify-center gap-1 rounded-xl bg-accent p-4 text-center text-white shadow-sm transition hover:bg-accent-dark"
        >
          <span className="text-2xl font-bold">דגם חדש</span>
          <span className="text-sm text-white/80">העלאת קובץ פרוס או הזנה ידנית</span>
        </Link>
      </div>
    </div>
  )
}
