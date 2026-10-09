// dsh-gateway Client half: the "IM 网关" settings page.
// Registered into the settings.section slot; polls /api/dsh-gateway/state.
//
// Resident-editor rules (enforced below):
//   1. Selecting a channel fills the editor with current server values.
//   2. Save unlocks only through dirty-checking (edit mode); no other source.
//   3. Status polling never refills a dirty form; clean forms refill only when
//      the server fingerprint actually changed (external edit).
//   4. Secrets are never echoed: password inputs stay empty; empty = keep,
//      typing = set, 清除 = clear; only a configured boolean is displayed.
//   5. Identity fields (kind, secrets) are locked while the channel is enabled.
window.__ModuleLoader__.load({
  id: '@slothtron/dsh-gateway',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const API = '/api/dsh-gateway'
    const POLL_MS = 3000

    const T = {
      text: 'var(--dsw-alias-label-primary, #2b2f36)',
      text2: 'var(--dsw-alias-label-secondary, #6b7280)',
      text3: 'var(--dsw-alias-label-tertiary, #9ca3af)',
      border: 'var(--dsw-alias-border-l2, #e5e7eb)',
      bg: 'var(--dsw-alias-bg-layer-2, #f4f5f7)',
      bgBase: 'var(--dsw-alias-bg-base, #ffffff)',
      brand: 'var(--dsw-alias-brand-primary, #3b82f6)',
      success: 'var(--dsw-alias-state-success-primary, #22c55e)',
      error: 'var(--dsw-alias-state-error-primary, #ef4444)',
    }

    async function api(pathname, options) {
      const res = await fetch(API + pathname, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
      })
      if (!res.ok) {
        let message = `HTTP ${res.status}`
        try { message = ((await res.json()).error) ?? message } catch { /* keep status */ }
        throw new Error(message)
      }
      return res.json()
    }

    // ---------------------------------------------------------------- drafts

    function blankDraft(kind) {
      return {
        kind: kind ?? '',
        label: '',
        config: {},
        secrets: {},      // field -> non-empty string = set this value
        secretClear: {},  // field -> true = clear stored value
        workspaceMode: 'default',
        workspacePath: '',
        sessionPolicy: { rotationEnabled: true, contextThresholdPct: 80, handoff: 'clean', archivePrevious: false },
      }
    }

    function draftFromRecord(record) {
      return {
        kind: record.kind,
        label: record.label,
        config: { ...(record.config ?? {}) },
        secrets: {},
        secretClear: {},
        workspaceMode: record.workspaceMode ?? 'default',
        workspacePath: record.workspacePath ?? '',
        sessionPolicy: { ...(record.sessionPolicy ?? {}) },
      }
    }

    /** Server-side fingerprint of everything the editor can edit. */
    function fingerprint(record) {
      const configuredSecrets = Object.entries(record.secrets ?? {})
        .filter(([, info]) => info?.configured)
        .map(([field]) => field)
        .sort()
      return JSON.stringify([
        record.kind, record.label, record.config ?? {}, record.workspaceMode ?? 'default',
        record.workspacePath ?? null, record.sessionPolicy ?? {}, record.enabled, configuredSecrets,
      ])
    }

    function secretsPayload(draft) {
      const payload = {}
      for (const [field, value] of Object.entries(draft.secrets)) {
        if (typeof value === 'string' && value.length > 0) payload[field] = value
      }
      for (const [field, clear] of Object.entries(draft.secretClear)) {
        if (clear && payload[field] === undefined) payload[field] = null
      }
      return payload
    }

    function payloadFrom(draft) {
      return {
        kind: draft.kind,
        label: draft.label,
        config: draft.config,
        secrets: secretsPayload(draft),
        workspaceMode: draft.workspaceMode,
        workspacePath: draft.workspacePath || null,
        sessionPolicy: draft.sessionPolicy,
      }
    }

    // ---------------------------------------------------------------- styles

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 14, fontSize: 14, color: T.text, minHeight: '100%' },
      statusRow: {
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '8px 12px', border: `1px solid ${T.border}`, borderRadius: 8, background: T.bg,
      },
      dot: (color) => ({
        width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block', flex: '0 0 auto',
      }),
      columns: { display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' },
      list: { flex: '0 1 240px', minWidth: 220, display: 'flex', flexDirection: 'column', gap: 6 },
      editor: { flex: '1 1 420px', minWidth: 340, border: `1px solid ${T.border}`, borderRadius: 8, padding: 14, background: T.bgBase },
      row: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8,
        border: `1px solid ${T.border}`, cursor: 'pointer', textAlign: 'left', background: 'transparent', width: '100%',
      },
      rowActive: { borderColor: T.brand, background: 'var(--dsw-alias-interactive-bg-hover, rgba(59,130,246,0.08))' },
      badge: {
        fontSize: 11, padding: '1px 7px', borderRadius: 4, border: `1px solid ${T.border}`,
        color: T.text2, whiteSpace: 'nowrap',
      },
      field: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 },
      label: { fontSize: 12, color: T.text2 },
      input: {
        fontSize: 13, padding: '6px 9px', borderRadius: 6, border: `1px solid ${T.border}`,
        background: 'var(--dsw-alias-bg-base, #fff)', color: T.text, width: '100%', boxSizing: 'border-box',
      },
      inputDisabled: { opacity: 0.55, cursor: 'not-allowed' },
      btn: {
        fontSize: 13, padding: '5px 14px', borderRadius: 6, border: `1px solid ${T.border}`,
        background: 'var(--dsw-alias-bg-base, #fff)', color: T.text, cursor: 'pointer',
      },
      btnPrimary: { background: T.brand, borderColor: T.brand, color: '#fff' },
      btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
      btnDanger: { color: T.error, borderColor: 'var(--dsw-alias-state-error-primary, #fca5a5)' },
      flash: (kind) => ({
        fontSize: 12, padding: '6px 10px', borderRadius: 6, marginBottom: 10,
        color: kind === 'ok' ? T.success : T.error, border: `1px solid ${T.border}`,
      }),
      hint: { color: T.text3, fontSize: 13, padding: '24px 8px', textAlign: 'center' },
      switch: (on) => ({
        width: 32, height: 18, borderRadius: 9, position: 'relative', display: 'inline-block',
        background: on ? T.success : 'var(--dsw-alias-label-tertiary, #9ca3af)', flex: '0 0 auto', border: 'none',
      }),
      thumb: { position: 'absolute', top: 2, width: 14, height: 14, borderRadius: '50%', background: '#fff' },
    }

    function Field({ title, children, hint }) {
      return h('div', { style: S.field },
        h('label', { style: S.label }, title),
        children,
        hint ? h('span', { style: { fontSize: 11, color: T.text3 } }, hint) : null,
      )
    }

    // --------------------------------------------------------- channel form

    function ChannelForm(props) {
      const { state, mode, draft, dirty, busy, flash, onTest, onSave, onCancel, onToggle, onDelete } = props
      const setDraft = props.setDraft
      const kindDef = (state?.kinds ?? []).find((k) => k.kind === draft.kind)
      const record = mode?.type === 'edit' ? (state?.channels ?? []).find((c) => c.id === mode.id) : null
      const locked = Boolean(record?.enabled)
      const creating = mode?.type === 'new'

      const set = (patch) => setDraft((prev) => ({ ...prev, ...patch }))
      const setConfig = (name, value) => setDraft((prev) => ({ ...prev, config: { ...prev.config, [name]: value } }))
      const setSecret = (name, value) => setDraft((prev) => ({
        ...prev, secrets: { ...prev.secrets, [name]: value }, secretClear: { ...prev.secretClear, [name]: false },
      }))
      const toggleClear = (name) => setDraft((prev) => ({
        ...prev, secrets: { ...prev.secrets, [name]: '' }, secretClear: { ...prev.secretClear, [name]: !prev.secretClear[name] },
      }))

      const plainFields = (kindDef?.fields ?? []).filter((f) => !f.secret)
      const secretFields = (kindDef?.fields ?? []).filter((f) => f.secret)
      const saveDisabled = Boolean(busy) || !draft.kind || !draft.label?.trim() || (mode.type === 'edit' && !dirty)

      return h('div', null,
        flash ? h('div', { style: S.flash(flash.kind) }, flash.text) : null,

        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: 14 } }, creating ? '新增通道' : (record ? record.label : '')),
          record ? h('span', { style: S.badge }, record.kind) : null,
          record ? h('span', { style: { fontSize: 12, color: record.connected ? T.success : T.text3 } },
            record.connected ? '● 在线' : '○ 离线') : null,
          h('span', { style: { flex: 1 } }),
          record ? h('button', { style: S.btn, disabled: Boolean(busy), onClick: onToggle },
            busy === 'toggle' ? '…' : (record.enabled ? '停用' : '启用')) : null,
          record ? h('button', { style: { ...S.btn, ...S.btnDanger }, disabled: Boolean(busy), onClick: onDelete },
            busy === 'delete' ? '…' : '删除') : null,
        ),

        h('div', { style: { ...S.columns, alignItems: 'stretch' } },
          h('div', { style: { flex: '1 1 240px', minWidth: 220 } },
            h(Field, { title: '平台', hint: locked ? '运行中锁定，停用后可更换' : undefined },
              h('select', {
                style: { ...S.input, ...(creating ? {} : S.inputDisabled) },
                value: draft.kind, disabled: !creating,
                onChange: (e) => set({ kind: e.target.value }),
              }, (state?.kinds ?? []).map((k) => h('option', { key: k.kind, value: k.kind }, k.kind))),
            ),
            h(Field, { title: '标签', hint: '用于在列表与会话中识别该通道' },
              h('input', {
                style: S.input, value: draft.label,
                onChange: (e) => set({ label: e.target.value }), placeholder: '如：飞书-客服',
              }),
            ),
            plainFields.length > 0 ? h('div', { style: { fontSize: 12, color: T.text3, margin: '8px 0 4px' } }, '连接配置') : null,
            plainFields.map((field) => {
              const current = draft.config[field.name] ?? (field.boolDefault ? field.defaultBool : '')
              if (field.boolDefault) {
                return h(Field, { key: field.name, title: field.name },
                  h('button', {
                    type: 'button', role: 'switch', 'aria-checked': String(Boolean(current)),
                    style: S.switch(Boolean(current)),
                    onClick: () => setConfig(field.name, !current),
                  }, h('span', { style: { ...S.thumb, left: current ? 16 : 2 } })),
                )
              }
              return h(Field, { key: field.name, title: field.name + (field.required ? ' *' : '') },
                h('input', {
                  style: S.input, value: current,
                  onChange: (e) => setConfig(field.name, e.target.value),
                  placeholder: field.required ? '必填' : '可选',
                }),
              )
            }),
          ),

          h('div', { style: { flex: '1 1 240px', minWidth: 220 } },
            secretFields.length > 0 ? h('div', { style: { fontSize: 12, color: T.text3, margin: '8px 0 4px' } }, '凭据（不回显）') : null,
            secretFields.map((field) => {
              const configured = Boolean(record?.secrets?.[field.name]?.configured)
              const willClear = Boolean(draft.secretClear[field.name])
              return h(Field, {
                key: field.name,
                title: field.name + (field.required ? ' *' : ''),
                hint: willClear ? '将清除已存凭据' : (configured ? '已配置 — 留空保持不变' : undefined),
              },
                h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                  h('input', {
                    type: 'password', autoComplete: 'new-password',
                    style: { ...S.input, ...(locked ? S.inputDisabled : {}) },
                    value: draft.secrets[field.name] ?? '',
                    disabled: locked,
                    onChange: (e) => setSecret(field.name, e.target.value),
                    placeholder: locked ? '停用后可修改' : (willClear ? '（将清除）' : (configured ? '留空保持不变' : '未配置')),
                  }),
                  (configured || willClear) && !locked ? h('button', {
                    type: 'button',
                    style: { ...S.btn, ...(willClear ? { borderColor: T.error, color: T.error } : {}) },
                    onClick: () => toggleClear(field.name),
                  }, willClear ? '撤销清除' : '清除') : null,
                ),
              )
            }),

            h('div', { style: { fontSize: 12, color: T.text3, margin: '8px 0 4px' } }, '工作区'),
            h(Field, { title: '会话工作区', hint: '不绑定 = 会话落在侧边栏「未分组」；指定 = 通道会话固定在该工作区目录（会显示在工作区分组下）' },
              h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
                h('label', { style: { fontSize: 12, display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' } },
                  h('input', {
                    type: 'radio', checked: draft.workspaceMode === 'default',
                    onChange: () => set({ workspaceMode: 'default' }),
                  }), '不绑定（未分组）'),
                h('label', { style: { fontSize: 12, display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' } },
                  h('input', {
                    type: 'radio', checked: draft.workspaceMode === 'pinned',
                    onChange: () => set({ workspaceMode: 'pinned' }),
                  }), '指定工作区'),
              ),
            ),
            draft.workspaceMode === 'pinned'
              ? h(Field, { title: '工作区目录' },
                h('select', {
                  style: S.input, value: draft.workspacePath,
                  onChange: (e) => set({ workspacePath: e.target.value }),
                },
                h('option', { value: '' }, '选择工作区…'),
                (state?.workspaces ?? []).map((w) => h('option', { key: w.id, value: w.path }, `${w.title} · ${w.path}`)),
                ))
              : null,

            h('div', { style: { fontSize: 12, color: T.text3, margin: '8px 0 4px' } }, '会话策略'),
            h(Field, { title: '上下文轮换', hint: '水位超过阈值后，下一条消息开启新会话（同一工作区）' },
              h('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
                h('button', {
                  type: 'button', role: 'switch', 'aria-checked': String(Boolean(draft.sessionPolicy.rotationEnabled)),
                  style: S.switch(Boolean(draft.sessionPolicy.rotationEnabled)),
                  onClick: () => setDraft((prev) => ({
                    ...prev,
                    sessionPolicy: { ...prev.sessionPolicy, rotationEnabled: !prev.sessionPolicy.rotationEnabled },
                  })),
                }, h('span', {
                  style: { ...S.thumb, left: draft.sessionPolicy.rotationEnabled ? 16 : 2 },
                })),
                draft.sessionPolicy.rotationEnabled
                  ? h('input', {
                    style: { ...S.input, width: 90 }, type: 'number', min: 5, max: 100,
                    value: draft.sessionPolicy.contextThresholdPct,
                    onChange: (e) => setDraft((prev) => ({
                      ...prev,
                      sessionPolicy: { ...prev.sessionPolicy, contextThresholdPct: Number(e.target.value) },
                    })),
                  })
                  : null,
                draft.sessionPolicy.rotationEnabled
                  ? h('span', { style: { fontSize: 12, color: T.text2 } }, '% 上下文水位')
                  : null,
              ),
            ),
          ),
        ),

        h('div', { style: { display: 'flex', gap: 8, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            style: { ...S.btn, ...(busy === 'test' ? S.btnDisabled : {}) },
            disabled: Boolean(busy) || !draft.kind, onClick: onTest,
          }, busy === 'test' ? '测试中…' : '测试连接'),
          h('span', { style: { flex: 1 } }),
          onCancel ? h('button', { style: S.btn, onClick: onCancel }, '取消') : null,
          h('button', {
            style: { ...S.btn, ...S.btnPrimary, ...(saveDisabled ? S.btnDisabled : {}) },
            disabled: saveDisabled, onClick: onSave,
          }, busy === 'save' ? '保存中…' : (creating ? '创建' : (dirty ? '保存' : '无改动'))),
        ),
      )
    }

    // ------------------------------------------------------------------ page

    function OctopBridgeSettings() {
      const [snapshot, setSnapshot] = useState(null)
      const [mode, setMode] = useState(null) // null | {type:'edit', id} | {type:'new'}
      const [draft, setDraft] = useState(null)
      const [dirty, setDirty] = useState(false)
      const [busy, setBusy] = useState(null)
      const [flash, setFlash] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const flashTimer = useRef(null)
      const baselineFpRef = useRef('')
      const dirtyRef = useRef(false)
      const modeRef = useRef(null)

      useEffect(() => { dirtyRef.current = dirty }, [dirty])
      useEffect(() => { modeRef.current = mode }, [mode])
      useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])

      const showFlash = useCallback((kind, text) => {
        setFlash({ kind, text })
        if (flashTimer.current) clearTimeout(flashTimer.current)
        flashTimer.current = setTimeout(() => setFlash(null), 6000)
      }, [])

      const fillEditor = useCallback((record) => {
        setMode({ type: 'edit', id: record.id })
        setDraft(draftFromRecord(record))
        baselineFpRef.current = fingerprint(record)
        setDirty(false)
        setFlash(null)
      }, [])

      const startCreate = useCallback((state) => {
        setMode({ type: 'new' })
        setDraft(blankDraft(state?.kinds?.[0]?.kind ?? ''))
        baselineFpRef.current = ''
        setDirty(false)
        setFlash(null)
      }, [])

      const updateDraft = useCallback((updater) => {
        setDraft((prev) => (prev ? updater(prev) : prev))
        setDirty(true)
      }, [])

      const closeEditor = useCallback(() => {
        setMode(null); setDraft(null); setDirty(false); setFlash(null)
      }, [])

      // Polling loop: never touches a dirty draft (rule 3). Clean editors
      // refill only on a server fingerprint change (external edit).
      useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const state = await api('/state')
            if (!alive) return
            setLoadError(null)
            setSnapshot(state)
            if (modeRef.current?.type === 'edit' && !dirtyRef.current) {
              const fresh = (state.channels ?? []).find((c) => c.id === modeRef.current.id)
              if (fresh) {
                const fp = fingerprint(fresh)
                if (fp !== baselineFpRef.current) {
                  setDraft(draftFromRecord(fresh))
                  baselineFpRef.current = fp
                }
              }
            }
          } catch (error) {
            if (alive) setLoadError(String(error?.message ?? error))
          }
        }
        tick()
        const id = setInterval(tick, POLL_MS)
        return () => { alive = false; clearInterval(id) }
      }, [])

      const runBusy = async (key, fn) => {
        if (busy) return undefined
        setBusy(key)
        try { return await fn() } finally { setBusy(null) }
      }

      const onSave = () => runBusy('save', async () => {
        try {
          const body = { ...payloadFrom(draft) }
          if (mode.type === 'edit') body.id = mode.id
          const result = await api('/channels', { method: 'POST', body: JSON.stringify(body) })
          const state = await api('/state')
          setSnapshot(state)
          const saved = (state.channels ?? []).find((c) => c.id === result.id)
          if (saved) fillEditor(saved)
          showFlash('ok', mode.type === 'new' ? '通道已创建，连接建立中' : '已保存')
        } catch (error) {
          showFlash('err', `保存失败：${error?.message ?? error}`)
        }
      })

      const onTest = () => runBusy('test', async () => {
        try {
          const body = { ...payloadFrom(draft) }
          if (mode.type === 'edit') body.channelId = mode.id
          const result = await api('/channels/test', { method: 'POST', body: JSON.stringify(body) })
          if (result.connected) showFlash('ok', `连接成功：${result.detail ?? 'connected'}`)
          else showFlash('err', `连接失败：${result.detail ?? '未在超时内就绪'}`)
        } catch (error) {
          showFlash('err', `测试失败：${error?.message ?? error}`)
        }
      })

      const onToggle = () => runBusy('toggle', async () => {
        try {
          const record = (snapshot?.channels ?? []).find((c) => c.id === mode.id)
          await api(`/channels/${mode.id}/toggle`, {
            method: 'POST', body: JSON.stringify({ enabled: !record?.enabled }),
          })
          const state = await api('/state')
          setSnapshot(state)
          const fresh = (state.channels ?? []).find((c) => c.id === mode.id)
          if (fresh) fillEditor(fresh)
        } catch (error) {
          showFlash('err', `切换失败：${error?.message ?? error}`)
        }
      })

      const onDelete = () => runBusy('delete', async () => {
        if (!(window.confirm && window.confirm('删除该通道？已路由的会话会保留在工作区。'))) return
        try {
          await api(`/channels/${mode.id}`, { method: 'DELETE' })
          closeEditor()
          setSnapshot(await api('/state'))
        } catch (error) {
          showFlash('err', `删除失败：${error?.message ?? error}`)
        }
      })

      const onRestart = () => runBusy('restart', async () => {
        try {
          await api('/sidecar/restart', { method: 'POST' })
          showFlash('ok', 'sidecar 已重启')
        } catch (error) {
          showFlash('err', `重启失败：${error?.message ?? error}`)
        }
      })

      const sidecar = snapshot?.sidecar
      const channels = snapshot?.channels ?? []
      const kindsReady = Boolean((snapshot?.kinds ?? []).length)

      return h('div', { style: S.page },
        h('div', { style: S.statusRow },
          h('span', { style: S.dot(sidecar?.running ? T.success : T.error) }),
          h('span', { style: { fontSize: 13 } },
            sidecar?.running
              ? `sidecar 运行中${sidecar.gatewayVersion ? ` · octop-gateway ${sidecar.gatewayVersion}` : ''}`
              : `sidecar 未运行${sidecar?.lastError ? ` — ${sidecar.lastError}` : ''}`,
          ),
          h('span', { style: { flex: 1 } }),
          h('button', {
            style: { ...S.btn, ...(busy === 'restart' ? S.btnDisabled : {}) },
            disabled: busy === 'restart', onClick: onRestart,
          }, '重启 sidecar'),
        ),
        loadError ? h('div', { style: S.flash('err') }, `状态获取失败：${loadError}`) : null,
        !kindsReady && snapshot ? h('div', { style: S.flash('err') }, '通道类型清单为空：sidecar 未就绪或未安装 octop-gateway') : null,

        h('div', { style: S.columns },
          h('div', { style: S.list },
            channels.length === 0 && snapshot
              ? h('div', { style: S.hint }, '暂无通道')
              : channels.map((record) => h('button', {
                key: record.id,
                style: {
                  ...S.row,
                  ...(mode?.type === 'edit' && mode.id === record.id ? S.rowActive : {}),
                  fontFamily: 'inherit',
                },
                onClick: () => fillEditor(record),
              },
                h('span', {
                  style: S.dot(record.connected
                    ? T.success
                    : (record.enabled ? 'var(--dsw-alias-label-tertiary, #9ca3af)' : T.error)),
                }),
                h('span', {
                  style: {
                    fontWeight: 500, fontSize: 13, flex: 1, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  },
                }, record.label),
                h('span', { style: S.badge }, record.kind),
                record.enabled ? null : h('span', { style: { fontSize: 11, color: T.text3 } }, '停用'),
              )),
            h('button', {
              style: { ...S.row, borderStyle: 'dashed', color: T.brand, justifyContent: 'center', fontFamily: 'inherit' },
              onClick: () => startCreate(snapshot),
              disabled: !kindsReady,
            }, '＋ 添加通道'),
          ),

          h('div', { style: S.editor },
            !snapshot ? h('div', { style: S.hint }, '加载中…')
              : !mode ? h('div', { style: S.hint }, '选择左侧通道，或添加新通道')
                : draft ? h(ChannelForm, {
                  state: snapshot, mode, draft, dirty, busy, flash,
                  setDraft: updateDraft,
                  onTest, onSave, onToggle, onDelete,
                  onCancel: mode.type === 'new' ? closeEditor : null,
                }) : null,
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'dsh-gateway', order: 80, label: 'IM 网关' },
          OctopBridgeSettings,
        ))
      },
    }
  },
})
