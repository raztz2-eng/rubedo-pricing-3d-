/** Minimal ambient types for the Google script we load at runtime (Picker). Sign-in is server-side (brief v0.4). */

interface GooglePickerDocument {
  id: string
  name?: string
  mimeType?: string
}

interface GooglePickerResponse {
  action: string
  docs?: GooglePickerDocument[]
}

interface GooglePickerDocsView {
  setSelectFolderEnabled(enabled: boolean): GooglePickerDocsView
  setMimeTypes(mimeTypes: string): GooglePickerDocsView
  setIncludeFolders(include: boolean): GooglePickerDocsView
}

interface GooglePickerBuilder {
  addView(view: GooglePickerDocsView): GooglePickerBuilder
  setOAuthToken(token: string): GooglePickerBuilder
  setDeveloperKey(key: string): GooglePickerBuilder
  setAppId(appId: string): GooglePickerBuilder
  setTitle(title: string): GooglePickerBuilder
  setLocale(locale: string): GooglePickerBuilder
  setCallback(cb: (response: GooglePickerResponse) => void): GooglePickerBuilder
  build(): { setVisible(visible: boolean): void }
}

interface Window {
  google?: {
    picker?: {
      DocsView: new (viewId?: string) => GooglePickerDocsView
      PickerBuilder: new () => GooglePickerBuilder
      ViewId: { FOLDERS: string; DOCS: string }
      Action: { PICKED: string; CANCEL: string }
    }
  }
  gapi?: {
    load(name: string, callback: { callback: () => void; onerror?: () => void } | (() => void)): void
  }
}
