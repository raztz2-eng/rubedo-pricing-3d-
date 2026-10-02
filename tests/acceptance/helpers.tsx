/**
 * Shared helpers for acceptance tests (Test Verifier). Outside-in: render the whole App with the in-memory Drive.
 * Expected numbers never come from here — they are written literally in the tests, copied from the brief §6–§7.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import { App } from '../../src/App'
import { createMemoryServices, type AppServices } from '../../src/state/services'

export type MemServices = ReturnType<typeof createMemoryServices>

export function renderApp(services: AppServices, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App services={services} />
    </MemoryRouter>,
  )
}

export function newServices(): { services: MemServices; root: string } {
  const services = createMemoryServices()
  return { services, root: services.folderPointer.get() as string }
}

export function fixtureBytes(name: string): Buffer {
  return readFileSync(resolve(process.cwd(), 'tests/fixtures', name))
}

export function fixtureFile(name: string): File {
  return new File([new Uint8Array(fixtureBytes(name))], name)
}

/** Sets a (controlled) input value. Used for numbers so "3.5" is not mangled by per-key typing in jsdom. */
export function setValue(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } })
}

/** The ₪ amount shown inside an element with the given test id, e.g. "₪9.35". */
export function moneyIn(testId: string, root: HTMLElement = document.body): string {
  const text = within(root).getByTestId(testId).textContent ?? ''
  const m = text.match(/-?₪[\d,]+\.\d{2}/)
  if (!m) throw new Error(`no money value in [data-testid=${testId}]: "${text}"`)
  return m[0]
}

/** Snapshot of the price panel (all ₪ values as displayed). */
export function panel(root: HTMLElement = document.body) {
  const p = within(root).getByTestId('price-panel')
  return {
    filament: moneyIn('cost-filament', p),
    hardware: moneyIn('cost-hardware', p),
    labor: moneyIn('cost-labor', p),
    packaging: moneyIn('cost-packaging', p),
    machine: moneyIn('cost-machine', p),
    landed: moneyIn('cost-landed', p),
    p50: moneyIn('price-50', p),
    p60: moneyIn('price-60', p),
    p70: moneyIn('price-70', p),
  }
}

export function nameInput(): HTMLInputElement {
  return screen.getByLabelText(/^שם \*$/) as HTMLInputElement
}

export async function addManualPart(user: { click: (el: Element) => Promise<void> }, grams: string, hours: string, qty?: string) {
  await user.click(screen.getByRole('button', { name: /הוספת חלק ידנית/ }))
  const rows = screen.getAllByTestId('part-row')
  const row = within(rows[rows.length - 1])
  setValue(row.getByLabelText('משקל'), grams)
  setValue(row.getByLabelText('זמן הדפסה'), hours)
  if (qty !== undefined) setValue(row.getByLabelText('כמות'), qty)
}

export function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'שמירה' }) as HTMLButtonElement
}

/** Visible label of the model page's edit button (brief v0.6 E1; was "עריכה" before v0.6). */
export const EDIT_BID_LABEL = 'עריכת הצעה'

/**
 * The model page's "עריכת הצעה" link, found by the label the Founder SEES (decorative icons ignored).
 * Exactly one must exist.
 */
export function editBidLink(): HTMLElement {
  const links = screen
    .queryAllByRole('link')
    .filter((l) => (l.textContent ?? '').replace(/[✎✏]\uFE0F?/gu, '').trim() === EDIT_BID_LABEL)
  if (links.length !== 1) throw new Error(`expected exactly one "${EDIT_BID_LABEL}" link, found ${links.length}`)
  return links[0]
}

export function navLink(name: string): HTMLElement {
  return within(screen.getByRole('navigation')).getByRole('link', { name })
}

/** jsdom has no object URLs; stub them so pictures render as <img>. Returns a restore function. */
export function stubObjectUrls(): () => void {
  const hadCreate = 'createObjectURL' in URL
  const origCreate = URL.createObjectURL
  const origRevoke = URL.revokeObjectURL
  let n = 0
  URL.createObjectURL = vi.fn(() => `blob:mock-${++n}`)
  URL.revokeObjectURL = vi.fn()
  return () => {
    if (hadCreate) {
      URL.createObjectURL = origCreate
      URL.revokeObjectURL = origRevoke
    } else {
      delete (URL as { createObjectURL?: unknown }).createObjectURL
      delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
    }
  }
}

export function pngFile(name: string): File {
  // Minimal bytes; content is irrelevant for the in-memory drive.
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], name, { type: 'image/png' })
}
