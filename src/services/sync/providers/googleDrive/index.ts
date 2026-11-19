import type { SyncProvider } from '../../provider.js'
import { googleAuth } from './auth.js'
import { createDriveBackend } from './backend.js'

export const googleDriveProvider: SyncProvider = {
  id: 'google-drive',
  label: 'syncProviderGoogleDrive',
  auth: googleAuth,
  createBackend: () => createDriveBackend(googleAuth),
}
