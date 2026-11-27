export function supportRealtimeRedisUrl(settings = process.env): string | undefined {
  if (settings.SUPPORT_REALTIME_REDIS_URL) return settings.SUPPORT_REALTIME_REDIS_URL
  if (settings.SUPPORT_REALTIME_DRIVER !== 'redis') return
  if (settings.REDIS_URL) return settings.REDIS_URL

  const host = settings.REDIS_HOST || 'localhost'
  const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const endpoint = new URL(`redis://${hostname}:${settings.REDIS_PORT || '6379'}/${settings.REDIS_DB || '0'}`)
  if (settings.REDIS_USERNAME) endpoint.username = encodeURIComponent(settings.REDIS_USERNAME)
  if (settings.REDIS_PASSWORD) endpoint.password = encodeURIComponent(settings.REDIS_PASSWORD)
  return endpoint.href
}
