import { useI18n } from '@stacksjs/i18n/stx'
import ar from '../../../locales/ar.yml'
import de from '../../../locales/de.yml'
import en from '../../../locales/en.yml'
import attachments from '../../../locales/agent-attachments.yml'

export function createInboxLocale() {
  return useI18n({ locale: 'en', fallbackLocale: 'en', messages: { en: { ...en.inbox, ...attachments.en }, de: { ...de.inbox, ...attachments.de }, ar: { ...ar.inbox, ...attachments.ar } } })
}
