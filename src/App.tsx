import { Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { EditModelPage, NewModelPage } from './pages/BidForm'
import { Home } from './pages/Home'
import { LibraryPage } from './pages/Library'
import { ModelPageRoute } from './pages/ModelPage'
import { SettingsPage } from './pages/Settings'
import { AppProvider } from './state/AppContext'
import type { AppServices } from './state/services'

/** Route table. Wrap in a Router (BrowserRouter in the app, MemoryRouter in tests). */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="new" element={<NewModelPage />} />
        <Route path="model/:id" element={<ModelPageRoute />} />
        <Route path="model/:id/edit" element={<EditModelPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export function App({ services }: { services: AppServices }) {
  return (
    <AppProvider services={services}>
      <AppRoutes />
    </AppProvider>
  )
}
