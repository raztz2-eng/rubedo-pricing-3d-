import type { CustomerQuoteSummary, QuoteSummary } from './bid'
import { isValidEmail, normaliseEmail } from './quote'

/**
 * Customers list (brief v0.6 E4). Pure — no I/O (the store is `drive/customerStore.ts`).
 * E-mail is unique (case-insensitive). Nothing is ever removed: a customer can only be hidden.
 */

export interface Customer {
  id: string
  name: string
  email: string
  phone?: string
  notes?: string
  /** Hidden customers are left out of pickers and shown on the customers page only under a toggle. */
  hidden?: boolean
  createdAt: string
  updatedAt: string
}

/** What the add/edit form controls. */
export interface CustomerInput {
  name: string
  email: string
  phone?: string
  notes?: string
}

export const DUPLICATE_EMAIL_MESSAGE = 'כבר קיים לקוח עם כתובת המייל הזו.'

function isCustomer(c: unknown): c is Customer {
  if (!c || typeof c !== 'object') return false
  const x = c as Customer
  return typeof x.id === 'string' && x.id !== '' && typeof x.name === 'string' && typeof x.email === 'string'
}

/**
 * Validates `_rubedo-customers.json`. The brief's format is a bare array; null when the content is not one
 * (the caller reports it — a damaged list is never silently replaced by an empty one).
 */
export function parseCustomers(raw: unknown): Customer[] | null {
  if (!Array.isArray(raw)) return null
  return raw.filter(isCustomer).map((c) => {
    const out: Customer = {
      id: c.id,
      name: c.name,
      email: c.email,
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : '',
      updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : '',
    }
    if (typeof c.phone === 'string' && c.phone !== '') out.phone = c.phone
    if (typeof c.notes === 'string' && c.notes !== '') out.notes = c.notes
    if (c.hidden === true) out.hidden = true
    return out
  })
}

/** Hebrew problems of a customer form (empty = OK). */
export function customerProblems(input: CustomerInput): string[] {
  const problems: string[] = []
  if (input.name.trim() === '') problems.push('יש להזין שם.')
  if (!isValidEmail(input.email)) problems.push('כתובת המייל אינה תקינה.')
  return problems
}

export function findByEmail(customers: readonly Customer[], email: string, excludeId?: string): Customer | undefined {
  const e = normaliseEmail(email)
  return customers.find((c) => c.id !== excludeId && normaliseEmail(c.email) === e)
}

/** Name or e-mail contains the query (case-insensitive). Empty query → everything. */
export function matchesCustomer(c: Customer, query: string): boolean {
  const q = query.trim().toLocaleLowerCase()
  if (q === '') return true
  return c.name.toLocaleLowerCase().includes(q) || c.email.toLocaleLowerCase().includes(q)
}

/** Customers for a picker: not hidden, matching the query, by name. */
export function pickerCustomers(customers: readonly Customer[], query: string): Customer[] {
  return customers
    .filter((c) => !c.hidden && matchesCustomer(c, query))
    .sort((a, b) => a.name.localeCompare(b.name, 'he'))
}

function clean(input: CustomerInput) {
  const fields: Pick<Customer, 'name' | 'email'> & Partial<Pick<Customer, 'phone' | 'notes'>> = {
    name: input.name.trim(),
    email: input.email.trim(),
  }
  if (input.phone?.trim()) fields.phone = input.phone.trim()
  if (input.notes?.trim()) fields.notes = input.notes.trim()
  return fields
}

/** Throws a Hebrew Error when the input is invalid or its e-mail belongs to another customer. */
function assertValid(customers: readonly Customer[], input: CustomerInput, excludeId?: string): void {
  const problems = customerProblems(input)
  if (problems.length > 0) throw new CustomerError(problems.join(' '))
  if (findByEmail(customers, input.email, excludeId)) throw new CustomerError(DUPLICATE_EMAIL_MESSAGE)
}

export class CustomerError extends Error {
  readonly userMessage: string
  constructor(userMessage: string) {
    super(userMessage)
    this.name = 'CustomerError'
    this.userMessage = userMessage
  }
}

export function withAddedCustomer(customers: readonly Customer[], input: CustomerInput, id: string, now: Date): { list: Customer[]; customer: Customer } {
  assertValid(customers, input)
  const t = now.toISOString()
  const customer: Customer = { id, ...clean(input), createdAt: t, updatedAt: t }
  return { list: [...customers, customer], customer }
}

export function withUpdatedCustomer(customers: readonly Customer[], id: string, input: CustomerInput, now: Date): { list: Customer[]; customer: Customer } {
  const current = customers.find((c) => c.id === id)
  if (!current) throw new CustomerError('הלקוח לא נמצא ברשימה.')
  assertValid(customers, input, id)
  const customer: Customer = { id, ...clean(input), createdAt: current.createdAt, updatedAt: now.toISOString() }
  if (current.hidden) customer.hidden = true
  return { list: customers.map((c) => (c.id === id ? customer : c)), customer }
}

export function withHiddenFlag(customers: readonly Customer[], id: string, hidden: boolean, now: Date): { list: Customer[]; customer: Customer } {
  const current = customers.find((c) => c.id === id)
  if (!current) throw new CustomerError('הלקוח לא נמצא ברשימה.')
  const customer: Customer = { ...current, updatedAt: now.toISOString() }
  if (hidden) customer.hidden = true
  else delete customer.hidden
  return { list: customers.map((c) => (c.id === id ? customer : c)), customer }
}

/**
 * Quotes of one customer, newest first. A log with a customerId belongs to that customer when it exists;
 * otherwise (logs before v0.6, or an unknown id) it is matched by e-mail (brief v0.6 E4).
 */
export function quotesForCustomer(quotes: readonly QuoteSummary[], customer: Customer, all: readonly Customer[]): QuoteSummary[] {
  const ids = new Set(all.map((c) => c.id))
  const email = normaliseEmail(customer.email)
  return quotes
    .filter((q) => (q.customerId && ids.has(q.customerId) ? q.customerId === customer.id : q.email === email))
    .sort(byDateDesc)
}

export function byDateDesc(a: { date: string }, b: { date: string }): number {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : 0
}

/** Index summary: quotes grouped by customerId when the log has one, else by lower-case e-mail. */
export function summariseQuotes(quotes: readonly QuoteSummary[]): CustomerQuoteSummary[] {
  const groups = new Map<string, CustomerQuoteSummary>()
  for (const q of quotes) {
    const key = q.customerId ? `id:${q.customerId}` : `email:${q.email}`
    const g = groups.get(key)
    if (!g) {
      const entry: CustomerQuoteSummary = { email: q.email, quoteCount: 1, lastQuoteAt: q.date }
      if (q.customerId) entry.customerId = q.customerId
      groups.set(key, entry)
    } else {
      g.quoteCount += 1
      if (q.date > g.lastQuoteAt) g.lastQuoteAt = q.date
    }
  }
  return [...groups.values()].sort(byLastQuoteDesc)
}

function byLastQuoteDesc(a: CustomerQuoteSummary, b: CustomerQuoteSummary): number {
  return byDateDesc({ date: a.lastQuoteAt }, { date: b.lastQuoteAt })
}
