import { Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { CreateFromFolderPage, EditModelPage, NewModelPage } from './pages/BidForm'
import { CustomerPageRoute, CustomersPageRoute } from './pages/Customers'
import { Home } from './pages/Home'
import { LibraryPage } from './pages/Library'
import { ModelPageRoute } from './pages/ModelPage'
import { QuotePageRoute } from './pages/QuotePage'
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
        <Route path="model/:id/create" element={<CreateFromFolderPage />} />
        <Route path="model/:id/quote" element={<QuotePageRoute />} />
        <Route path="customers" element={<CustomersPageRoute />} />
        <Route path="customers/:id" element={<CustomerPageRoute />} />
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
