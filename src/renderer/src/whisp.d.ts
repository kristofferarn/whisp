import type { WhispApi } from '../../shared/ipc'

declare global {
  interface Window {
    whisp: WhispApi
  }
}

export {}
