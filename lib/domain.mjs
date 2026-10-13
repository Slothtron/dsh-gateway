// Storage domain for dsh-gateway: channel definitions and subject routes.
// Schemas are zod (DomainSpec requirement); plugin Config stays schemastery.
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

// How a channel's sessions manage a filling context. The bridge only decides
// WHEN to act: crossing the threshold asks the host's compaction engine to
// reduce history in place (the session continues). How much is retained, and
// how the summary is produced, stay with that engine.
export const sessionPolicySchema = z.object({
  compactEnabled: z.boolean().default(true),
  compactThresholdPct: z.number().min(5).max(100).default(80),
  /** Archive the superseded session when /model, /workspace or /new replaces it. */
  archivePrevious: z.boolean().default(false),
})

/**
 * Which registered workspaces a channel's sessions may use. `all` places no
 * restriction; `selected` is a whitelist of workspace directory paths. The
 * first selected path is also where an unrestricted-by-override session is
 * created, so a scoped channel has a home instead of silently landing in the
 * ungrouped bucket.
 */
export const workspaceAccessSchema = z.object({
  mode: z.enum(['all', 'selected']).default('all'),
  paths: z.array(z.string()).default([]),
})

export const channelSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  /** Display name, derived once at creation as `<kind label>-<shortId>`. */
  label: z.string().min(1),
  /** Six-character public suffix of `label`; unique among the stored channels. */
  shortId: z.string().default(''),
  enabled: z.boolean().default(true),
  /** Plain (non-secret) config fields, as accepted by the channel kind's Config dataclass. */
  config: z.record(z.string(), z.unknown()).default({}),
  /** Secret field name -> credential ref (POSIX env-style name). Values never live here. */
  secretRefs: z.record(z.string(), z.string()).default({}),
  workspaceAccess: workspaceAccessSchema.default({ mode: 'all', paths: [] }),
  // Retired (v2) single-workspace binding. Declared on purpose: a bare object
  // schema STRIPS unknown keys on load, which would silently turn a pinned
  // channel into an unrestricted one. `normalizeChannel` folds the value into
  // `workspaceAccess` and drops these two keys.
  workspaceMode: z.enum(['default', 'pinned']).optional(),
  workspacePath: z.string().nullable().optional(),
  sessionPolicy: sessionPolicySchema.default({
    compactEnabled: true,
    compactThresholdPct: 80,
    archivePrevious: false,
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const routeSchema = z.object({
  key: z.string().min(1),
  channelId: z.string().min(1),
  subjectId: z.string().min(1),
  /** Empty until the first message creates one: a command may reserve the
   * route's overrides before any session exists. */
  sessionId: z.string().default(''),
  generation: z.number().int().min(0).default(0),
  chatType: z.string().default(''),
  /** Routing metadata from the last inbound message (msg_id, to_handle, ...). */
  lastMetadata: z.record(z.string(), z.unknown()).default({}),
  /** Route-scoped model picked via /model; null = harness default. Persists across rotations. */
  modelOverride: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
  }).nullable().default(null),
  /** Route-scoped workspace directory picked via /workspace; null = channel config. */
  cwdOverride: z.string().nullable().default(null),
  /** /new, /model and /workspace set this; the next inbound message opens a new session. */
  rotateOnNext: z.boolean().default(false),
  /** Last in-place compaction this route performed, for im_list_channels. */
  lastCompaction: z.object({
    at: z.string(),
    shadowedCount: z.number().int().min(0),
    shadowedTokens: z.number().min(0),
  }).nullable().default(null),
  updatedAt: z.string(),
})

export const dshGatewayDomain = defineDomain({
  name: 'dsh_gateway',
  // Deliberately still 2. `dsh-storage-json` compares the whole-unit stamp
  // EXACTLY (`parse()` rejects on `version !== descriptor.version`); only
  // per-record documents consult `compatibleVersions`. This domain uses the
  // default single layout, so a bump would make every existing
  // `~/.dsh/storages/dsh_gateway.json` fail to open. The v3 shape is therefore
  // expressed as a LENIENT schema instead: the retired rotation keys are
  // stripped on read and the compaction policy defaults in, so an older file
  // loads and keeps a working policy.
  version: 2,
  compatibleVersions: [1],
  tables: {
    channels: domainTable(channelSchema),
    routes: domainTable(routeSchema),
  },
})

/**
 * Storage unit name for one profile scope.
 *
 * The configuration lives at PROFILE scope: each profile reads its own unit, so a
 * channel configured in one profile does not even exist in another — nothing
 * cross-profile has to be tracked, and the plugin stays a thin wrapper over the
 * platform. A tree with no profile identity (unit tests, a hand-built tree) keeps
 * the bare name so it still has somewhere to write.
 *
 * @param scope - profile token from `profileScope()`, '' for an unidentified tree.
 * @returns storage unit name, e.g. `dsh_gateway_web_test`.
 */
export function gatewayDomainName(scope = '') {
  return scope ? `dsh_gateway_${scope}` : 'dsh_gateway'
}

/** The domain declaration for one profile scope (see {@link gatewayDomainName}). */
export function gatewayDomain(scope = '') {
  const name = gatewayDomainName(scope)
  return name === dshGatewayDomain.name
    ? dshGatewayDomain
    : defineDomain({ ...dshGatewayDomain, name })
}

/**
 * Six characters that identify a channel to a human: `23456789` plus the
 * lowercase letters minus `l`, `o` and `i`, so a name read aloud or typed into
 * an IM window cannot be confused with another one.
 */
export const SHORT_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'
export const SHORT_ID_LENGTH = 6

/** A fresh public id, unique against `taken` (regenerating on collision). */
export function makeShortId(taken = new Set(), random = Math.random) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    let id = ''
    for (let i = 0; i < SHORT_ID_LENGTH; i += 1) {
      id += SHORT_ID_ALPHABET[Math.floor(random() * SHORT_ID_ALPHABET.length)]
    }
    if (!taken.has(id)) return id
  }
  throw new Error('could not allocate a unique channel id')
}

/**
 * Public id for a record stored before `shortId` existed. Derived from the
 * record's uuid, so it is stable and as unique as the uuid itself.
 */
export function shortIdFromChannelId(channelId) {
  const chars = String(channelId ?? '').toLowerCase().replace(/[^0-9a-z]/g, '')
  return (chars + '000000').slice(0, SHORT_ID_LENGTH)
}

/** The display name every channel gets at creation: platform name + public id. */
export function channelLabel(kindLabel, shortId) {
  return `${String(kindLabel ?? '').trim() || '通道'}-${shortId}`
}

/**
 * Fold a stored record into the current shape, in place. Idempotent.
 *
 * Only the retired v2 workspace binding needs folding: a `pinned` channel
 * becomes a one-entry access scope. Everything else is a default the schema
 * already applies on load.
 */
export function normalizeChannel(record) {
  if (!record) return record
  if (record.workspaceMode === 'pinned' && record.workspacePath) {
    record.workspaceAccess = { mode: 'selected', paths: [String(record.workspacePath)] }
  }
  delete record.workspaceMode
  delete record.workspacePath
  // The schema applies this default on load; filling it here too makes the
  // function total, so a caller holding a raw record never sees the field as
  // missing.
  if (!record.workspaceAccess) record.workspaceAccess = { mode: 'all', paths: [] }
  if (!record.shortId) record.shortId = shortIdFromChannelId(record.id)
  return record
}

/**
 * Open this profile's tables, folding in every migration the current shape needs.
 *
 * @param ctx - plugin context, for the storage facility and the logger.
 * @param scope - profile token from `profileScope()`; '' opens the unit a tree with
 *   no profile identity uses (unit tests, a hand-built tree).
 * @returns `{ domain, scope, channels, routes }` — the handles the caller keeps using.
 */
export async function openTables(ctx, scope = '') {
  const domain = await ctx.storageDomain.open(gatewayDomain(scope))
  // The facility hands the handle to the caller and does not tie it to this
  // fiber, while an open domain keeps its name reserved. Without an owner-side
  // disposer the name stays taken for the life of the host process, so
  // disabling and re-enabling the plugin fails with `already-open` (the domain
  // is opened on every activation). Registering it before the migration loop
  // also covers a migration that throws: the context then closes the handle.
  ctx.effect(() => () => domain.close(), 'dsh-gateway.domainClose')
  const channels = domain.table('channels')
  const routes = domain.table('routes')
  // Records are validated on load, not on read, so the retirement of the v2
  // workspace binding has to happen here — and has to be written back, or every
  // later read would see the legacy keys again. A failed write is loud in the
  // log but must not stop the plugin: the in-memory record is already folded.
  for (const [id, record] of channels.entries()) {
    if (record.workspaceMode === undefined && record.shortId) continue
    normalizeChannel(record)
    await channels.put(id, record).catch((error) => {
      ctx.logger.warn('dsh-gateway: could not persist the migration of channel %s: %s', id, error)
    })
  }
  await dropOrphanRoutes(ctx, channels, routes)
  return { domain, scope, channels, routes }
}

/**
 * Remove subject routes whose channel is gone.
 *
 * A route is keyed `<channelId>:<subjectId>` and means "this IM conversation owns
 * that session". Deleting a channel used to remove only the channel record, so a
 * store could keep routes pointing at nothing: invisible in the page (it lists
 * channels) but still growing the file. Sweeping on load heals an existing store
 * and keeps a crash mid-delete from leaving anything behind.
 *
 * @param ctx - plugin context, for the logger.
 * @param channels - the channels table.
 * @param routes - the routes table.
 */
export async function dropOrphanRoutes(ctx, channels, routes) {
  const known = new Set()
  for (const [id] of channels.entries()) known.add(id)
  const orphans = []
  for (const [key, route] of routes.entries()) {
    if (!known.has(route.channelId)) orphans.push(key)
  }
  if (orphans.length === 0) return 0
  for (const key of orphans) {
    try {
      await routes.delete(key)
    } catch (error) {
      ctx.logger.warn('dsh-gateway: could not drop the orphaned route %s: %s', key, error)
    }
  }
  ctx.logger.warn('dsh-gateway: dropped %d orphaned subject route(s) whose channel no longer exists', orphans.length)
  return orphans.length
}

/** Deterministic POSIX credential ref for one channel secret field. */
export function refFor(channelId, field) {
  return `DSH_GATEWAY_${String(channelId).replaceAll('-', '').toUpperCase()}_${String(field).toUpperCase()}`
}
