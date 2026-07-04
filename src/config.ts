import { readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { promises as fs } from "node:fs"
import { dirname, join } from "node:path"
import { getStateDir } from "./xdg.ts"

const RELAY_CONFIG_FILENAME = "cross-session-relay.json"
const SUPPRESSION_FILENAME = "cross-session-suppressed.json"

interface RelayConfig {
  current: string | null
  history: string[]
}

function getConfigPath(): string {
  return join(getStateDir(), RELAY_CONFIG_FILENAME)
}

function readConfig(): RelayConfig {
  try {
    const raw = readFileSync(getConfigPath(), "utf8")
    const parsed = JSON.parse(raw) as Partial<RelayConfig>
    return {
      current: parsed.current ?? null,
      history: Array.isArray(parsed.history) ? parsed.history : [],
    }
  } catch {
    return { current: null, history: [] }
  }
}

async function writeConfig(config: RelayConfig): Promise<void> {
  const path = getConfigPath()
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, JSON.stringify(config, null, 2), "utf8")
}

function normalizeRelayUrl(url: string): string {
  return url.replace(/^ws(s?):\/\//, "http$1://")
}

export function getRelayUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const envUrl = env.CROSS_SESSION_RELAY_URL?.trim()
  if (envUrl && envUrl.length > 0) return normalizeRelayUrl(envUrl)
  const stored = readConfig().current
  return stored ? normalizeRelayUrl(stored) : null
}

export function getRelayHistory(): string[] {
  return readConfig().history
}

export async function writeRelayUrl(url: string): Promise<void> {
  const config = readConfig()
  config.current = url
  if (!config.history.includes(url)) {
    config.history.unshift(url)
  } else {
    config.history = [url, ...config.history.filter((h) => h !== url)]
  }
  await writeConfig(config)
}

export async function clearRelayUrl(): Promise<void> {
  const config = readConfig()
  config.current = null
  await writeConfig(config)
}

function getSuppressionPath(): string {
  return join(getStateDir(), SUPPRESSION_FILENAME)
}

export function readSuppressedSessions(): Set<string> {
  try {
    const raw = readFileSync(getSuppressionPath(), "utf8")
    return new Set(JSON.parse(raw) as string[])
  } catch {
    return new Set()
  }
}

export function addSuppressedSession(sessionId: string): void {
  const set = readSuppressedSessions()
  set.add(sessionId)
  writeFileSync(getSuppressionPath(), JSON.stringify([...set]))
}

export function clearSuppressedSessions(): void {
  try {
    unlinkSync(getSuppressionPath())
  } catch {
    /* ignore */
  }
}
