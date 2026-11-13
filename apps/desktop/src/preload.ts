import { contextBridge, ipcRenderer } from 'electron'

// The only thing the page gets from the shell (RFC 0046): a native folder dialog. Everything else goes through the web host.
contextBridge.exposeInMainWorld('visDesktop', {
  pickDirectory: (defaultPath?: string) => ipcRenderer.invoke('vis:pick-directory', defaultPath),
})
