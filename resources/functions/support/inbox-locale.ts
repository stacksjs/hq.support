import { useI18n } from '@stacksjs/i18n/stx'
import ar from '../../../locales/ar.yml'
import de from '../../../locales/de.yml'
import en from '../../../locales/en.yml'

export function createInboxLocale() {
  return useI18n({ locale: 'en', fallbackLocale: 'en', messages: { en: en.inbox, de: de.inbox, ar: ar.inbox } })
}
