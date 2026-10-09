// Agent-facing tools: list channels/subjects and push text proactively.
import { defineTool } from '@deepseek-ai/dsh-tools'

export function registerTools(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'im_list_channels',
    description:
      'List configured IM gateway channels and the conversation subjects routed so far. ' +
      'Use the channel id and subject id with im_push_text.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      const channels = []
      for (const [id, record] of deps.tables.channels.entries()) {
        channels.push({ id, kind: record.kind, label: record.label, enabled: record.enabled })
      }
      const subjects = []
      for (const route of deps.router.routes.values()) {
        subjects.push({
          channel_id: route.channelId,
          subject_id: route.subjectId,
          chat_type: route.chatType,
          session_id: route.sessionId,
          generation: route.generation,
          rotatable: route.rotatable,
        })
      }
      return { channels, subjects }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'im_push_text',
    description:
      'Push a text message proactively to a known IM subject through its gateway channel. ' +
      'Discover channel and subject ids with im_list_channels.',
    parameters: {
      channel_id: { type: 'string', required: true, description: 'Channel instance id from im_list_channels' },
      subject_id: { type: 'string', required: true, description: 'Subject id: user open id for DMs, conversation id for groups' },
      text: { type: 'string', required: true, description: 'Text message to send' },
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, error: { type: 'string' } },
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: value.ok ? 'pushed' : `push failed: ${value.error ?? 'unknown error'}` },
      ],
    },
    async execute(args) {
      const record = deps.tables.channels.get(String(args.channel_id))
      if (!record) return { ok: false, error: 'channel not found' }
      if (!record.enabled) return { ok: false, error: 'channel disabled' }
      const route = deps.router.routes.get(`${record.id}:${args.subject_id}`)
      const subject = {
        subject_id: String(args.subject_id),
        display_name: '',
        chat_type: route?.chatType ?? '',
        metadata: route?.lastMetadata ?? {},
      }
      try {
        const result = await deps.sidecar.request(
          { op: 'push_text', channel_id: record.id, subject, text: String(args.text) },
          60_000,
        )
        return result.ok === true ? { ok: true } : { ok: false, error: String(result.error ?? 'unknown') }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    },
  }))
}
