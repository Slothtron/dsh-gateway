// Storage domain for dsh-gateway: channel definitions and subject routes.
// Schemas are zod (DomainSpec requirement); plugin Config stays schemastery.
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const sessionPolicySchema = z.object({
  rotationEnabled: z.boolean().default(true),
  contextThresholdPct: z.number().min(5).max(100).default(80),
  handoff: z.enum(['clean', 'summary']).default('clean'),
  archivePrevious: z.boolean().default(false),
})

export const channelSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Plain (non-secret) config fields, as accepted by the channel kind's Config dataclass. */
  config: z.record(z.string(), z.unknown()).default({}),
  /** Secret field name -> credential ref (POSIX env-style name). Values never live here. */
  secretRefs: z.record(z.string(), z.string()).default({}),
  workspaceMode: z.enum(['default', 'pinned']).default('default'),
  workspacePath: z.string().nullable().default(null),
  sessionPolicy: sessionPolicySchema.default({
    rotationEnabled: true,
    contextThresholdPct: 80,
    handoff: 'clean',
    archivePrevious: false,
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const routeSchema = z.object({
  key: z.string().min(1),
  channelId: z.string().min(1),
  subjectId: z.string().min(1),
  sessionId: z.string().min(1),
  generation: z.number().int().min(1).default(1),
  rotatable: z.boolean().default(false),
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
  /** Switch commands set this; the next inbound message opens a new session. */
  rotateOnNext: z.boolean().default(false),
  updatedAt: z.string(),
})

export const dshGatewayDomain = defineDomain({
  name: 'dsh_gateway',
  // v2: route records gained modelOverride / cwdOverride / rotateOnNext.
  version: 2,
  compatibleVersions: [1],
  tables: {
    channels: domainTable(channelSchema),
    routes: domainTable(routeSchema),
  },
})

export async function openTables(ctx) {
  const domain = await ctx.storageDomain.open(dshGatewayDomain)
  return { domain, channels: domain.table('channels'), routes: domain.table('routes') }
}

/** Deterministic POSIX credential ref for one channel secret field. */
export function refFor(channelId, field) {
  return `DSH_GATEWAY_${String(channelId).replaceAll('-', '').toUpperCase()}_${String(field).toUpperCase()}`
}
