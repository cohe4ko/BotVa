import { readFileSync, existsSync, statSync } from 'fs'
import { resolve } from 'path'

export interface TeamConfig {
  manager: string
  bots: Record<string, { description: string }>
}

let cached: TeamConfig | null = null
let cachedMtime = 0

export function getTeamConfig(projectRoot: string): TeamConfig {
  const teamPath = resolve(projectRoot, 'workspace', 'team.json')
  if (!existsSync(teamPath)) {
    return { manager: '', bots: {} }
  }

  try {
    const { mtimeMs } = statSync(teamPath)
    if (cached && mtimeMs === cachedMtime) return cached

    const data = JSON.parse(readFileSync(teamPath, 'utf-8'))
    cached = data
    cachedMtime = mtimeMs
    return data
  } catch {
    return { manager: '', bots: {} }
  }
}

export function isManager(projectRoot: string, botName: string): boolean {
  return getTeamConfig(projectRoot).manager === botName
}

export function getManagerName(projectRoot: string): string {
  return getTeamConfig(projectRoot).manager
}
