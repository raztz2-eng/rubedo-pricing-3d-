import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import './index.css'
import { detectMode } from './lib/config'
import { seedDemo } from './state/demoSeed'
import { createGoogleServices, createMemoryServices, createUnconfiguredServices, type AppServices } from './state/services'

async function boot() {
  const mode = detectMode()
  let services: AppServices
  if (mode === 'demo') {
    const demo = createMemoryServices()
    await seedDemo(demo.drive, demo.folderPointer.get() as string)
    services = demo
  } else if (mode === 'google') {
    services = createGoogleServices()
  } else {
    services = createUnconfiguredServices()
  }

  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <BrowserRouter>
        <App services={services} />
      </BrowserRouter>
    </StrictMode>,
  )
}

void boot()
