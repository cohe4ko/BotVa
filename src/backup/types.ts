export interface BackupManifest {
  version: 1
  type: 'bot' | 'system'
  botName?: string
  createdAt: string
  hostname: string
  botvaVersion: string
  checksum: string
  bots: string[]
  totalSize: number
}

export interface BackupOptions {
  type: 'bot' | 'system'
  botName?: string
  outputDir?: string
}

export interface RestoreOptions {
  archivePath: string
  targetBotName?: string
  overwrite?: boolean
  dryRun?: boolean
}

export interface BackupInfo {
  filename: string
  path: string
  manifest: BackupManifest
  sizeBytes: number
  createdAt: Date
}

export interface ScheduleConfig {
  enabled: boolean
  type: 'bot' | 'system'
  botName?: string
  cron: string
  retentionCount: number
}
