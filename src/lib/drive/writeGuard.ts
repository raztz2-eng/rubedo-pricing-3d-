import { FOLDER_MIME, INDEX_FILE_NAME, SETTINGS_FILE_NAME } from '../bid'
import { DriveError, NOT_APP_FILE_MESSAGE, type DriveFile } from './types'

/**
 * The app's own Drive write rules (brief v0.4 D-F), shared by every DriveStore so the real store and the in-memory
 * fake behave identically:
 *  - creates (folders, files) always carry `appProperties.rubedo = "1"`;
 *  - content updates are allowed ONLY for files carrying that marker;
 *  - never delete, trash, move, rename or change permissions (no such operation exists anywhere).
 *
 * Legacy exception (files the app created before v0.4 have no marker): ONLY `_rubedo-settings.json` and
 * `_rubedo-index.json`, ONLY when they sit directly in the models folder with that exact name, may be updated —
 * and the same update adds the marker, so the exception is used at most once per file.
 */

export const APP_PROPERTY_KEY = 'rubedo'
export const APP_PROPERTY_VALUE = '1'
/** Metadata added to everything the app creates. */
export const APP_PROPERTIES: Readonly<Record<string, string>> = Object.freeze({ [APP_PROPERTY_KEY]: APP_PROPERTY_VALUE })

/** The only file names the legacy exception can ever apply to. */
export const LEGACY_ADOPTABLE_NAMES: readonly string[] = [SETTINGS_FILE_NAME, INDEX_FILE_NAME]

/** Caller's claim "this is the pre-v0.4 settings/index file of this models folder". Verified against metadata. */
export interface LegacyAdoption {
  modelsFolderId: string
  name: string
}

export interface UpdateOptions {
  adoptLegacy?: LegacyAdoption
}

/** 'marked' = normal update; 'adopt' = legacy settings/index file: update and add the marker in the same request. */
export type UpdateDecision = 'marked' | 'adopt'

export function hasAppMarker(appProperties: Record<string, string> | undefined | null): boolean {
  return appProperties?.[APP_PROPERTY_KEY] === APP_PROPERTY_VALUE
}

/** Decides whether a content update of `meta` is allowed; throws a 403 DriveError (Hebrew) otherwise. */
export function decideUpdate(meta: DriveFile, options: UpdateOptions = {}): UpdateDecision {
  if (meta.mimeType === FOLDER_MIME || meta.mimeType.startsWith('application/vnd.google-apps.')) {
    throw new DriveError(`refused: ${meta.id} is not a plain file`, NOT_APP_FILE_MESSAGE, 403)
  }
  if (meta.appCreated === true) return 'marked'
  const legacy = options.adoptLegacy
  if (
    legacy &&
    LEGACY_ADOPTABLE_NAMES.includes(legacy.name) &&
    meta.name === legacy.name &&
    (meta.parents ?? []).includes(legacy.modelsFolderId)
  ) {
    return 'adopt'
  }
  throw new DriveError(`refused: ${meta.id} has no app marker`, NOT_APP_FILE_MESSAGE, 403)
}
