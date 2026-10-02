import type {
  GameList,
  GameMetadata,
  IPluginAPI,
  ScraperIdentifier,
  ScraperProvider
} from './types'

/** 数据源注册 id（与 package.json 的 id 字段保持一致） */
export const PROVIDER_ID = 'kungal-catalog'
const DEFAULT_BASE_URL = 'https://api.nextmoe.dev/v2'
const REQUEST_TIMEOUT_MS = 15000

interface KungalConfig {
  apiKey: string
  baseUrl: string
  lang: string
  nsfw: boolean
}

/** 读取插件配置（插件设置面板中用户填写的值） */
async function getConfig(api: IPluginAPI): Promise<KungalConfig> {
  const [apiKey, baseUrl, lang, nsfw] = await Promise.all([
    api.PluginDB.getValue('apiKey', ''),
    api.PluginDB.getValue('baseUrl', DEFAULT_BASE_URL),
    api.PluginDB.getValue('lang', 'zh-Hans'),
    api.PluginDB.getValue('nsfw', true)
  ])
  return {
    apiKey: String(apiKey ?? ''),
    baseUrl: String(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    lang: String(lang ?? 'zh-Hans'),
    nsfw: nsfw !== false
  }
}

// ===================== 本地限流（服务端限流 60 次/分，滑动窗口留余量） =====================
const RATE_LIMIT_PER_MIN = 55
const RATE_LIMIT_WINDOW_MS = 60_000
/** 本地滑动窗口内的请求时间戳（所有请求共享，含失败请求——服务端同样计量） */
const requestTimestamps: number[] = []

/** 请求前节流：窗口已满则等最早记录滑出窗口；等待超过 maxWaitMs 则直接提示用户 */
async function throttleLocal(maxWaitMs = 5000): Promise<void> {
  const now = Date.now()
  while (requestTimestamps.length > 0 && requestTimestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
    requestTimestamps.shift()
  }
  if (requestTimestamps.length >= RATE_LIMIT_PER_MIN) {
    const waitMs = requestTimestamps[0] + RATE_LIMIT_WINDOW_MS - now
    if (waitMs > maxWaitMs) {
      throw new Error(
        `KunGalgame API 请求过于频繁（限速 ${RATE_LIMIT_PER_MIN} 次/分），请 ${Math.ceil(waitMs / 1000)} 秒后重试`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    await throttleLocal(maxWaitMs - waitMs)
  }
}

/** Retry-After 头：仅支持 delta-seconds 数字格式 */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const sec = Number(value)
  return Number.isFinite(sec) && sec >= 0 ? Math.ceil(sec) : null
}

/** 带鉴权、本地节流与限流感知的 GET 请求，返回 JSON 载荷 */
async function fetchJson(api: IPluginAPI, path: string, attempt = 0): Promise<any> {
  const { apiKey, baseUrl } = await getConfig(api)
  if (!apiKey) {
    throw new Error('未配置 API Key：请在插件设置中填写 NextMoe 开发者门户铸造的 nmk_ 密钥')
  }

  // 本地滑动窗口节流，避免自我触发服务端限流
  await throttleLocal()

  let res: Response
  try {
    res = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    throw new Error(`网络请求失败: ${error instanceof Error ? error.message : String(error)}`)
  }
  requestTimestamps.push(Date.now())

  if (!res.ok) {
    // 房内错误信封 {code, message}
    let detail = ''
    try {
      const body = await res.json()
      detail = typeof body?.message === 'string' ? body.message : JSON.stringify(body)
    } catch {
      /* 忽略解析失败 */
    }

    if (res.status === 429) {
      return await handleRateLimit(api, path, res, detail, attempt)
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`API 鉴权失败 (${res.status})：请检查 API Key 与 catalog:read scope`)
    }
    throw new Error(`API 请求失败 (${res.status})${detail ? `: ${detail}` : ''}`)
  }
  return res.json()
}

/**
 * 429 处理（服务端限流 60 次/分、日配额 50,000 次/日）：
 * - 日配额（X-Quota-* 头或错误消息含 quota/配额）→ 直接提示，不重试
 * - 分钟限流且 Retry-After ≤ 15s → 自动等待后重试一次（最多重试 1 次，避免雪崩）
 * - 其余 → 抛出带等待时间的明确提示
 */
async function handleRateLimit(
  api: IPluginAPI,
  path: string,
  res: Response,
  detail: string,
  attempt: number
): Promise<any> {
  const headerKeys: string[] = []
  res.headers.forEach((_value, key) => headerKeys.push(key))
  const headerNames = headerKeys.map((k) => k.toLowerCase())
  const isQuota =
    headerNames.some((k) => k.startsWith('x-quota')) || /quota|配额/i.test(detail)

  if (isQuota) {
    throw new Error('KunGalgame API 今日配额已用尽（50,000 次/日），请明日再试或更换 API Key')
  }

  const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
  if (retryAfter !== null && retryAfter <= 15 && attempt < 1) {
    // 服务端明确告知等待时间且较短：自动等待重试一次，用户无感
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000))
    return fetchJson(api, path, attempt + 1)
  }

  throw new Error(
    `KunGalgame API 请求过于频繁（限流 60 次/分）${retryAfter ? `，请 ${retryAfter} 秒后重试` : '，请稍后重试'}`
  )
}

/**
 * 按首选语言取名字。
 * 契约：localized[locale] ?? display_name（display_name 一般为日文原名）。
 * v2 的 localized 值为 { value, is_machine } 对象；同时兼容旧形状的裸字符串。
 */
function pickName(work: any, lang: string): string {
  const localized = work?.localized
  if (lang === 'zh-Hans' && localized) {
    const zh = localized['zh-Hans'] ?? localized['zh-Hant']
    if (typeof zh === 'string' && zh) return zh
    if (zh && typeof zh.value === 'string' && zh.value) return zh.value
  }
  return work?.display_name ?? String(work?.id ?? '')
}

/** 简介：同语言内优先人工行（is_machine=false），机翻仅在该语言无人工行时使用 */
function pickIntro(intros: any[], lang: string): string {
  if (!Array.isArray(intros) || intros.length === 0) return ''
  const candidates = intros.filter((i) => i && typeof i.value === 'string')
  const inLang = candidates.filter((i) => i.lang === lang)
  const ja = candidates.filter((i) => i.lang === 'ja')
  const human = (rows: any[]) => rows.find((i) => !i.is_machine)
  return (human(inLang) ?? inLang[0] ?? human(ja) ?? ja[0] ?? candidates[0])?.value ?? ''
}

/** 月精度日期形如 2024-06-00，归一为 01；无日期返回空串 */
function normalizeReleaseDate(date: string | null | undefined): string {
  if (!date) return ''
  return date.replace(/-00$/, '-01')
}

/** 把外部 id 识别为 (source, external_id) 反查对；不认识的格式返回 null */
function toRef(value: string): { source: string; externalId: string } | null {
  // VNDB vn id：v19658（小写 v）
  const vndb = /^v\d+$/i.exec(value)
  if (vndb) return { source: 'vndb', externalId: value.toLowerCase() }
  // DLsite workno：RJ123456 / RE123456 / VJ123456（规范大写）
  const dlsite = /^(rj|re|vj)\d+$/i.exec(value)
  if (dlsite) return { source: 'dlsite', externalId: value.toUpperCase() }
  return null
}

/** identifier 解析为 catalog work id：数字 id 直查、外部 id（vndb/dlsite）经 refs 反查、名称搜索 */
async function resolveWorkId(api: IPluginAPI, identifier: ScraperIdentifier): Promise<string> {
  const { nsfw } = await getConfig(api)

  if (identifier.type === 'id') {
    const value = identifier.value.trim()
    if (/^\d+$/.test(value)) {
      // catalog work id：验证存在性
      await fetchJson(api, `/catalog/works/${encodeURIComponent(value)}?nsfw=${nsfw}`)
      return value
    }
    const ref = toRef(value)
    if (ref) {
      // 官方反查车道：works?refs=source:external_id（未命中返回空页 + missing[]）
      const data = await fetchJson(
        api,
        `/catalog/works?refs=${encodeURIComponent(`${ref.source}:${ref.externalId}`)}&nsfw=${nsfw}`
      )
      const items: any[] = Array.isArray(data?.items) ? data.items : []
      if (items.length === 0) {
        throw new Error(`外部 id 未在 KunGalgame 目录中找到: ${value}（目录可能未收录该作）`)
      }
      return String(items[0].id)
    }
    throw new Error(`无法识别的 id 格式: ${value}（支持 catalog 数字 id、VNDB v*、DLsite RJ/RE/VJ*）`)
  }

  const data = await fetchJson(
    api,
    `/catalog/search?q=${encodeURIComponent(identifier.value)}&object=work&limit=5&nsfw=${nsfw}`
  )
  const hits = (data?.items ?? []).filter((h: any) => h.target_object === 'work')
  if (hits.length === 0) {
    throw new Error(`未在 KunGalgame 目录中找到作品: ${identifier.value}`)
  }
  return String(hits[0].id)
}

export function createKungalProvider(api: IPluginAPI): ScraperProvider {
  const provider: ScraperProvider = {
    id: PROVIDER_ID,
    name: 'KunGalgame',

    async searchGames(gameName: string): Promise<GameList> {
      const { lang, nsfw } = await getConfig(api)
      const data = await fetchJson(
        api,
        `/catalog/search?q=${encodeURIComponent(gameName)}&object=work&limit=20&nsfw=${nsfw}`
      )
      const hits = (data?.items ?? []).filter((h: any) => h.target_object === 'work')
      return hits.map((h: any) => ({
        id: String(h.id),
        name: pickName(h, lang),
        releaseDate: '',
        developers: ['']
      }))
    },

    // Vnite 数据源列表要求 provider 具备该能力（requireAll 过滤）。
    // 语义：校验 identifier 在数据源中真实存在（按 ID 添加游戏时用于校验输入；
    // 支持 catalog 数字 id、VNDB v*、DLsite RJ/RE/VJ* 与名称）
    async checkGameExists(identifier: ScraperIdentifier): Promise<boolean> {
      try {
        await resolveWorkId(api, identifier)
        return true
      } catch {
        return false
      }
    },

    async getGameMetadata(identifier: ScraperIdentifier): Promise<GameMetadata> {
      const workId = await resolveWorkId(api, identifier)
      const { lang, nsfw } = await getConfig(api)
      const work = await fetchJson(
        api,
        `/catalog/works/${workId}?include=intros,releases,ratings,tags,companies,links&nsfw=${nsfw}`
      )

      const releases: any[] = Array.isArray(work?.releases) ? work.releases : []
      const dated = releases
        .filter((r) => r?.date)
        .sort((a, b) => (a.date < b.date ? -1 : 1))
      const releaseDate =
        dated.length > 0 ? normalizeReleaseDate(dated[0].date) : normalizeReleaseDate(work?.release_date)

      const companies: any[] = Array.isArray(work?.companies) ? work.companies : []
      const byRole = (roles: string[]) =>
        companies
          .filter((c) => roles.includes(c?.attribution_role))
          .map((c) => c.display_name)
          .filter(Boolean)
      const developers = byRole(['developer', 'brand', 'circle'])
      const publishers = byRole(['publisher'])

      const tags = [
        ...new Set(
          (Array.isArray(work?.tags) ? (work.tags as any[]) : [])
            .map((t: any) => t?.display_name)
            .filter((n: any): n is string => typeof n === 'string' && n.length > 0)
        )
      ]

      // KunGalgame 自身页面链接置顶；links 按 source 去重，重复 source 只保留第一项
      const seenSources = new Set<string>()
      const relatedSites = [
        { label: 'KunGalgame', url: `https://www.moyu.moe/galgame/${workId}` },
        ...(Array.isArray(work?.links) ? work.links : [])
          .filter((l: any) => l?.url)
          .map((l: any) => ({ label: String(l.source ?? 'link'), url: String(l.url) }))
          .filter((l: any) => {
            const key = String(l.label).toLowerCase()
            if (seenSources.has(key)) return false
            seenSources.add(key)
            return true
          })
      ]

      const platforms = [
        ...new Set(
          releases
            .flatMap((r: any) => [r?.platform, ...(Array.isArray(r?.platforms) ? r.platforms : [])])
            .filter((p: any): p is string => typeof p === 'string' && p.length > 0)
        )
      ]

      // 评分：源原生刻度（vndb 1-10 / bangumi 0-10 / dlsite 0-5 / erogamescape 0-100），绝不归一
      const extra = (Array.isArray(work?.ratings) ? work.ratings : [])
        .filter((r: any) => typeof r?.score === 'number')
        .map((r: any) => ({
          key: `rating_${r.source}`,
          value: [`${r.score}${typeof r.vote_count === 'number' ? `（${r.vote_count} 票）` : ''}`]
        }))

      return {
        name: pickName(work, lang),
        originalName: work?.display_name ?? null,
        releaseDate,
        description: pickIntro(work?.intros, lang),
        developers: developers.length > 0 ? developers : [''],
        relatedSites,
        tags,
        publishers: publishers.length > 0 ? publishers : undefined,
        platforms: platforms.length > 0 ? platforms : undefined,
        extra: extra.length > 0 ? extra : undefined
      }
    },

    async getGameCovers(identifier: ScraperIdentifier): Promise<string[]> {
      const workId = await resolveWorkId(api, identifier)
      const { nsfw } = await getConfig(api)
      const data = await fetchJson(api, `/catalog/works/${workId}/covers?nsfw=${nsfw}`)
      const items: any[] = Array.isArray(data?.items) ? data.items : []
      const pinned = items
        .filter((c) => c?.portrait_pinned)
        .map((c) => c?.url)
        .filter(Boolean)
      const rest = items.map((c) => c?.url).filter(Boolean)
      // 整体倒序：Vnite 取数组第一张保存，倒序后即优先采用原顺序的最后一张
      return [...pinned, ...rest.filter((u) => !pinned.includes(u))].reverse()
    },

    async getGameBackgrounds(identifier: ScraperIdentifier): Promise<string[]> {
      const workId = await resolveWorkId(api, identifier)
      const { nsfw } = await getConfig(api)
      try {
        const data = await fetchJson(api, `/catalog/works/${workId}/screenshots?nsfw=${nsfw}`)
        const urls = (Array.isArray(data?.items) ? data.items : [])
          .map((s: any) => s?.url)
          .filter(Boolean)
        if (urls.length > 0) return urls
      } catch {
        /* 回落到 banner */
      }
      try {
        const work = await fetchJson(api, `/catalog/works/${workId}?nsfw=${nsfw}`)
        if (work?.banner?.url) return [work.banner.url]
      } catch {
        /* 忽略 */
      }
      return []
    }
  }

  return provider
}
