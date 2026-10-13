// Which profile an activation belongs to — the token a channel's `profile` field
// is written with.
//
// The channel store is scoped to a PROFILE: the token below is what names its
// storage unit (`dsh_gateway_web`), so another profile's channels are not loaded
// here at all. Thin wrapper: the platform owns delivery semantics, the profile
// owns the configuration.
//
// Cordis mounts a plugin into the tree whose YAML declared the row, and every
// context in that tree inherits the tree's `baseUrl`. This package's row is
// inserted by its own bundle patch, which the profile layer composes into the
// PROFILE's tree, so `ctx.baseUrl` is the profile directory
// (`<DSH_HOME>/profiles/<name>/`).
//
// Verified against a live boot of a scratch profile, for both a profile-layer row
// and a bundle-inserted row: `ctx.baseUrl` was
// `file:///<DSH_HOME>/profiles/<name>/` in both cases, and a `!!js baseUrl` in the
// patch saw the same value.
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Profiles live under this directory in the harness home. */
export const PROFILES_DIR = 'profiles'

/**
 * The token used when the mounting tree is not a profile (unit tests, a hand-built
 * tree). Empty means "unknown profile": nothing is adopted, and unbound channels
 * stay unbound so a real profile can claim them later.
 */
export const UNKNOWN_SCOPE = ''

/**
 * A profile name as a comparable, storage-safe token.
 *
 * @param name - profile directory name.
 * @returns lowercase token matching `^[a-z][a-z0-9_]*$`, or '' when nothing usable remains.
 */
export function scopeToken(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^[^a-z]+/, '')
}

/**
 * Resolve the profile scope of one activation.
 *
 * @param ctx - the plugin context; only `baseUrl` is read.
 * @returns `{ scope, profile }`; `scope` is '' when no profile directory is
 *   identifiable, in which case the caller must not claim ownership.
 */
export function profileScope(ctx) {
  const baseUrl = ctx?.baseUrl
  if (typeof baseUrl !== 'string' || !baseUrl.startsWith('file:')) return { scope: UNKNOWN_SCOPE, profile: null }
  let dir
  try {
    dir = fileURLToPath(baseUrl)
  } catch {
    return { scope: UNKNOWN_SCOPE, profile: null }
  }
  const clean = dir.replace(/[\\/]+$/, '')
  const profile = basename(clean)
  // Only a directory directly under `profiles/` is a profile; anything else (a
  // bundle loaded by hand, a nested tree) has no identity to claim channels with.
  if (profile === '' || basename(dirname(clean)) !== PROFILES_DIR) {
    return { scope: UNKNOWN_SCOPE, profile: null }
  }
  const scope = scopeToken(profile)
  return scope === '' ? { scope: UNKNOWN_SCOPE, profile: null } : { scope, profile }
}
