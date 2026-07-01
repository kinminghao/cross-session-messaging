import { join } from "node:path"
import { REGISTRY_DIR_NAME, REGISTRY_FILENAME } from "./constants.ts"

/**
 * Resolve the opencode state directory following XDG conventions.
 * Corresponds to executable plan §T3.
 *
 * Priority (matches XDG Base Directory Specification):
 *   1. `$XDG_STATE_HOME/opencode/`
 *   2. `$HOME/.local/state/opencode/`
 *   3. throw if neither is set (rare — set explicitly in tests via env)
 *
 * `env` is injectable so tests can point the registry at a temp dir
 * without touching real user state.
 */
export function getStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME?.trim()
  if (xdg && xdg.length > 0) return join(xdg, REGISTRY_DIR_NAME)
  const home = env.HOME?.trim()
  if (!home || home.length === 0) {
    throw new Error("Neither XDG_STATE_HOME nor HOME env is set")
  }
  return join(home, ".local", "state", REGISTRY_DIR_NAME)
}

/** Absolute path to the shared registry file. */
export function getRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getStateDir(env), REGISTRY_FILENAME)
}
