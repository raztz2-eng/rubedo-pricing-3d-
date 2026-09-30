import { FOLDER_MIME } from '../bid'
import { DriveError, NOT_APP_FILE_MESSAGE, type DriveFile } from './types'

/**
 * The app's own Drive write rules (brief v0.4 D-F), shared by every DriveStore so the real store and the in-memory
 * fake behave identically:
 *  - creates (folders, files) always carry `appProperties.rubedo = "1"`;
 *  - content updates are allowed ONLY for files carrying that marker — no exceptions (AC22). A file the app wrote
 *    before v0.4 (no marker) is never rewritten: the app creates a new marked file next to it instead;
 *  - never delete, trash, move, rename or change sharing (no such operation exists anywhere).
 */

export const APP_PROPERTY_KEY = 'rubedo'
export const APP_PROPERTY_VALUE = '1'
/** Metadata added to everything the app creates. */
export const APP_PROPERTIES: Readonly<Record<string, string>> = Object.freeze({ [APP_PROPERTY_KEY]: APP_PROPERTY_VALUE })

export function hasAppMarker(appProperties: Record<string, string> | undefined | null): boolean {
  return appProperties?.[APP_PROPERTY_KEY] === APP_PROPERTY_VALUE
}

/** Throws a 403 DriveError (Hebrew) unless a content update of `meta` is allowed. */
export function assertUpdatable(meta: DriveFile): void {
  if (meta.mimeType === FOLDER_MIME || meta.mimeType.startsWith('application/vnd.google-apps.')) {
    throw new DriveError(`refused: ${meta.id} is not a plain file`, NOT_APP_FILE_MESSAGE, 403)
  }
  if (meta.appCreated !== true) throw new DriveError(`refused: ${meta.id} has no app marker`, NOT_APP_FILE_MESSAGE, 403)
}
