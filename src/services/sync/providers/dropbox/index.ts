import type { SyncProvider } from '../../provider.js'
import { dropboxAuth } from './auth.js'
import { createDropboxBackend } from './backend.js'

export const dropboxProvider: SyncProvider = {
  id: 'dropbox',
  label: 'syncProviderDropbox',
  note: 'syncProviderDropboxNote',
  auth: dropboxAuth,
  createBackend: () => createDropboxBackend(dropboxAuth),
}
