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
  /** Always written by the app; absent only in entries someone else wrote without it (never written as ''). */
  createdAt?: string
  updatedAt?: string
}

/** What the add/edit form controls. */
export interface CustomerInput {
  name: string
  email: string
  phone?: string
  notes?: string
}

export const DUPLICATE_EMAIL_MESSAGE = 'כבר קיים לקוח עם כתובת המייל הזו.'

const optionalString = (v: unknown) => v === undefined || typeof v === 'string'

function isCustomer(c: unknown): c is Customer {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false
  const x = c as Record<string, unknown>
  return (
    typeof x.id === 'string' &&
    x.id !== '' &&
    typeof x.name === 'string' &&
    typeof x.email === 'string' &&
    optionalString(x.phone) &&
    optionalString(x.notes) &&
    optionalString(x.createdAt) &&
    optionalString(x.updatedAt) &&
    (x.hidden === undefined || typeof x.hidden === 'boolean')
  )
}

/**
 * Validates `_rubedo-customers.json` (the brief's format: a bare array). null when the content is not one OR when ANY
 * entry is not a valid customer (C1): the caller then reports the file as damaged and writes nothing — a list that
 * cannot be fully understood is never rewritten. Entries are kept as they are, unknown fields included.
 */
export function parseCustomers(raw: unknown): Customer[] | null {
  if (!Array.isArray(raw)) return null
  if (!raw.every(isCustomer)) return null
  return raw.map((c) => ({ ...c }))
}

function updatedAtOf(c: Customer): string {
  return typeof c.updatedAt === 'string' ? c.updatedAt : ''
}

/**
 * Several customers files (e.g. two created at the same moment) are read as ONE list (I1c): merged by id, the entry
 * with the newer updatedAt wins; order = first appearance.
 */
export function mergeCustomerLists(lists: readonly (readonly Customer[])[]): Customer[] {
  const byId = new Map<string, Customer>()
  for (const list of lists) {
    for (const c of list) {
      const seen = byId.get(c.id)
      if (!seen || updatedAtOf(c) > updatedAtOf(seen)) byId.set(c.id, c)
    }
  }
  return [...byId.values()]
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
  // Every other field (createdAt, hidden, fields the app does not know) is kept as it was.
  const customer: Customer = { ...current, ...clean(input), updatedAt: now.toISOString() }
  if (!input.phone?.trim()) delete customer.phone
  if (!input.notes?.trim()) delete customer.notes
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

/**
 * Index summary: quotes grouped by customerId. A log without one (written before v0.6) joins the customer with its
 * e-mail — taken from `customers` when given, else from other logs of that e-mail that carry an id; otherwise it is
 * grouped by lower-case e-mail.
 */
export function summariseQuotes(quotes: readonly QuoteSummary[], customers?: readonly Customer[]): CustomerQuoteSummary[] {
  const idByEmail = new Map<string, string>()
  if (customers) for (const c of customers) idByEmail.set(normaliseEmail(c.email), c.id)
  else for (const q of quotes) if (q.customerId && !idByEmail.has(q.email)) idByEmail.set(q.email, q.customerId)
  const groups = new Map<string, CustomerQuoteSummary>()
  for (const q of quotes) {
    const customerId = q.customerId ?? idByEmail.get(q.email)
    const key = customerId ? `id:${customerId}` : `email:${q.email}`
    const g = groups.get(key)
    if (!g) {
      const entry: CustomerQuoteSummary = { email: q.email, quoteCount: 1, lastQuoteAt: q.date }
      if (customerId) entry.customerId = customerId
      groups.set(key, entry)
    } else {
      g.quoteCount += 1
      if (q.date > g.lastQuoteAt) {
        g.lastQuoteAt = q.date
        g.email = q.email
      }
    }
  }
  return [...groups.values()].sort(byLastQuoteDesc)
}

function byLastQuoteDesc(a: CustomerQuoteSummary, b: CustomerQuoteSummary): number {
  return byDateDesc({ date: a.lastQuoteAt }, { date: b.lastQuoteAt })
}
