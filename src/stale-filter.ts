const BOT_START_TIME = Date.now()
const STALE_THRESHOLD = 30000 // 30 seconds

export function isStaleMessage(messageDate: number): boolean {
  const messageDateMs = messageDate * 1000
  return messageDateMs < BOT_START_TIME - STALE_THRESHOLD
}

export function getUptimeSeconds(): number {
  return Math.floor((Date.now() - BOT_START_TIME) / 1000)
}

export function getUptimeFormatted(): string {
  const seconds = getUptimeSeconds()

  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60

  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60

  if (hours < 24) return `${hours}h ${remainingMinutes}m`

  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24

  return `${days}d ${remainingHours}h`
}
