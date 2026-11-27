import { createI18n, formatDateTime, isRTL } from '@stacksjs/i18n/client'
import ar from '../../../locales/ar.yml'
import de from '../../../locales/de.yml'
import en from '../../../locales/en.yml'

const messages = { en: en.messenger, de: de.messenger, ar: ar.messenger }
export type MessengerLocale = keyof typeof messages
const translations = new Map<MessengerLocale, ReturnType<typeof createI18n>>()

export function messengerLocale(locale?: string): MessengerLocale {
  if (!locale) return 'en'
  if (Object.hasOwn(messages, locale)) return locale as MessengerLocale
  throw new Error('This messenger supports English (en), German (de), and Arabic (ar).')
}

export function messengerText(locale: MessengerLocale, key: string, values?: Record<string, string | number>): string {
  let translation = translations.get(locale)
  if (!translation) {
    translation = createI18n({ locale, fallbackLocale: 'en', messages })
    translations.set(locale, translation)
  }
  return translation.t(key, values)
}

export function messengerDirection(locale: MessengerLocale): 'rtl' | 'ltr' {
  return isRTL(locale) ? 'rtl' : 'ltr'
}

export function messengerDate(locale: MessengerLocale, timestamp: string): string {
  return formatDateTime(timestamp, 'medium', 'short', locale)
}
