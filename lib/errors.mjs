// Platform failures, said in a way the person holding the phone can act on.
//
// The library is the authority on what went wrong and reports it in whatever
// shape the platform used: a WeChat errcode, a QQ response body, a Feishu
// refusal. Those strings name a platform concept, not a next step, and this
// module turns the ones we have seen into a next step — nothing here decides
// whether an error *is* one, and an unrecognized message is passed through
// unchanged rather than dressed up.
//
// Every rule matches on text the platform or the library produced. Adding one
// is a copy change: keep it narrow (a phrase that only ever means this failure)
// and put the actionable half first.

const RULES = [
  {
    // QQ's token endpoint, echoed verbatim from the response body.
    match: /invalid appid or secret|['"]code['"]\s*:\s*100016/i,
    text: '凭据无效：到开放平台重新复制 App ID 与 App Secret（或重新扫码登录）后保存；沙箱与正式环境的凭据不通用',
  },
  {
    match: /missing required credentials:\s*(.+)$/im,
    text: (match) => `凭据不完整：缺少 ${match[1].split(',').map((name) => name.trim()).filter(Boolean).join('、')}`,
  },
  {
    match: /feishu token refresh failed/i,
    text: '飞书凭据校验失败：App ID / App Secret 与应用的启用状态需要核对',
  },
  {
    // 微信 long-poll: the platform rejected the session and the channel waits
    // for a fresh scan.
    match: /errcode['":\s-]*14\b|session expired \(errcode -14\)/i,
    text: '微信登录态已失效：需要在这个通道上重新扫码登录',
  },
  {
    match: /no ready event within timeout/i,
    text: '已经启动但没能在时限内连上：检查凭据是否属于当前环境（沙箱/正式），以及该账号是否在别处同时登录',
  },
  {
    match: /no access_token in response/i,
    text: '平台没有下发 access_token：通常是 App ID / App Secret 不匹配，或该应用尚未启用',
  },
]

/**
 * One platform failure as a single sentence.
 *
 * @param {unknown} error - an Error, a sidecar `detail` string, or any value.
 * @returns {string} the actionable sentence, or the original message when no
 *   rule recognizes it.
 */
export function describeChannelError(error) {
  const raw = typeof error === 'string'
    ? error
    : String(error?.message ?? error ?? '')
  const trimmed = raw.trim()
  if (!trimmed) return '未知错误（没有错误信息）'
  for (const rule of RULES) {
    const match = rule.match.exec(trimmed)
    if (!match) continue
    const text = typeof rule.text === 'function' ? rule.text(match) : rule.text
    // Keep the platform's own wording beside the advice: if the advice is
    // wrong, the original sentence is what the user has to search for.
    return trimmed.includes(text) ? trimmed : `${text}（平台原话：${trimmed}）`
  }
  return trimmed
}
