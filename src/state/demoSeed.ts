import { DEFAULT_MATERIALS } from '../lib/bid'
import { newSaveSession, saveNewBid } from '../lib/drive/bidRepository'
import type { DriveStore } from '../lib/drive/types'
import { computePrice, DEFAULT_PRICING_SETTINGS } from '../lib/pricing'

/** Demo mode only: one sample bid (brief test case T1) so the library is not empty. */
export async function seedDemo(drive: DriveStore, modelsFolderId: string): Promise<void> {
  const settings = { ...DEFAULT_PRICING_SETTINGS }
  const material = { ...DEFAULT_MATERIALS[0] }
  const input = {
    pricePerKg: material.pricePerKg,
    parts: [{ qty: 1, grams: 100, hours: 3.5 }],
    laborMinutes: 10,
    hardware: [],
    hasShipping: false,
    packaging: [],
    shippingCost: 0,
  }
  await saveNewBid(
    drive,
    modelsFolderId,
    {
      folderName: 'דגם לדוגמה',
      content: {
        name: 'דגם לדוגמה',
        revision: 'V1',
        description: 'הצעה לדוגמה (מקרה בדיקה T1): 100 ג׳, 3.5 שעות, 10 דקות עבודה.',
        material,
        parts: [{ name: 'חלק 1', qty: 1, grams: 100, hours: 3.5, source: 'manual' }],
        laborMinutes: 10,
        hardware: [],
        hasShipping: false,
        packaging: [],
        shippingCost: 0,
        settingsSnapshot: settings,
        result: computePrice(input, settings),
      },
      files: [],
    },
    newSaveSession(),
  )
}
