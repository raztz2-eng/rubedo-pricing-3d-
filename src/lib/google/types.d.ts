/** Minimal ambient types for the Google scripts we load at runtime (GIS token client + Picker). */

interface GoogleTokenResponse {
  access_token?: string
  expires_in?: number | string
  scope?: string
  error?: string
  error_description?: string
}

interface GoogleTokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void
}

interface GoogleTokenClientConfig {
  client_id: string
  scope: string
  callback: (response: GoogleTokenResponse) => void
  error_callback?: (error: { type: string; message?: string }) => void
}

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
    accounts?: {
      oauth2: {
        initTokenClient(config: GoogleTokenClientConfig): GoogleTokenClient
        revoke(token: string, done?: () => void): void
      }
    }
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
