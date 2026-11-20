import type { SyncProvider } from '../../provider.js'
import { googleAuth } from './auth.js'
import { createDriveBackend } from './backend.js'

export const googleDriveProvider: SyncProvider = {
  id: 'google-drive',
  label: 'syncProviderGoogleDrive',
  note: 'syncProviderGoogleDriveNote',
  auth: googleAuth,
  createBackend: () => createDriveBackend(googleAuth),
}
