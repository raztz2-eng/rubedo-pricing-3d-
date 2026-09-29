import { FOLDER_MIME } from '../bid'
import { googleConfig } from '../config'
import { GAPI_SRC, loadScript } from '../google/loadScript'

export interface PickedFolder {
  id: string
  name: string
}

export class PickerError extends Error {
  readonly userMessage: string
  constructor(message: string, userMessage: string) {
    super(message)
    this.name = 'PickerError'
    this.userMessage = userMessage
  }
}

let pickerLoaded: Promise<void> | null = null

function loadPicker(): Promise<void> {
  pickerLoaded ??= loadScript(GAPI_SRC).then(
    () =>
      new Promise<void>((resolve, reject) => {
        if (!window.gapi) {
          reject(new Error('gapi missing'))
          return
        }
        window.gapi.load('picker', { callback: () => resolve(), onerror: () => reject(new Error('picker load failed')) })
      }),
  )
  pickerLoaded.catch(() => {
    pickerLoaded = null
  })
  return pickerLoaded
}

/** Opens Google Picker to choose the models folder. Resolves null if the user cancels. */
export async function pickModelsFolder(accessToken: string): Promise<PickedFolder | null> {
  if (!googleConfig.apiKey || !googleConfig.appId) {
    throw new PickerError(
      'picker config missing',
      'חסרים הגדרות VITE_GOOGLE_API_KEY / VITE_GOOGLE_APP_ID — לא ניתן לפתוח את בוחר התיקיות.',
    )
  }
  try {
    await loadPicker()
  } catch {
    throw new PickerError('picker load failed', 'לא ניתן לטעון את בוחר התיקיות של Google. בדקו את החיבור לאינטרנט.')
  }
  const picker = window.google?.picker
  if (!picker) throw new PickerError('picker missing', 'בוחר התיקיות של Google לא זמין.')

  return new Promise<PickedFolder | null>((resolve) => {
    const view = new picker.DocsView(picker.ViewId.FOLDERS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMimeTypes(FOLDER_MIME)
    const instance = new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey(googleConfig.apiKey)
      .setAppId(googleConfig.appId)
      .setLocale('iw')
      .setTitle('בחרו את תיקיית הדגמים (3d › models)')
      .setCallback((resp) => {
        if (resp.action === picker.Action.PICKED && resp.docs?.[0]) {
          resolve({ id: resp.docs[0].id, name: resp.docs[0].name ?? '' })
        } else if (resp.action === picker.Action.CANCEL) {
          resolve(null)
        }
      })
      .build()
    instance.setVisible(true)
  })
}
