import type { BawkApi } from '../shared/api'

declare global {
  interface Window {
    api: BawkApi
  }
}
