import { useI18n } from '@stacksjs/i18n/stx'
import messages from '../../../locales/agent-inbox.yml'

export function createInboxLocale() {
  return useI18n({ locale: 'en', fallbackLocale: 'en', messages })
}
