import type { SyncProvider } from '../../provider.js'
import { webdavAuth } from './auth.js'
import { createWebdavBackend } from './backend.js'

export const webdavProvider: SyncProvider = {
  id: 'webdav',
  label: 'syncProviderWebdav',
  note: 'syncProviderWebdavNote',
  connectFields: [
    {
      key: 'url',
      label: 'syncWebdavUrl',
      type: 'url',
      placeholder: 'https://cloud.example.com/remote.php/dav/files/me/chat-demo/',
      autoComplete: 'url',
    },
    { key: 'username', label: 'syncWebdavUsername', type: 'text', autoComplete: 'username' },
    {
      key: 'password',
      label: 'syncWebdavPassword',
      type: 'password',
      autoComplete: 'current-password',
    },
  ],
  auth: webdavAuth,
  createBackend: createWebdavBackend,
}
