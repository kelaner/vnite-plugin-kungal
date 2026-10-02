// Smoke test for kungal-catalog plugin (run with Node 20+)
const assert = require('assert')

const plugin = require('../dist/index.js').default || require('../dist/index.js')

const config = new Map([
  ['apiKey', ''],
  ['baseUrl', 'https://api.nextmoe.dev/v2'],
  ['lang', 'zh-Hans'],
  ['nsfw', true]
])

let registered = null
let unregistered = null
const api = {
  pluginId: 'kungal-catalog',
  PluginDB: {
    getValue: async (k, d) => (config.has(k) ? config.get(k) : d),
    setValue: async () => {}
  },
  scraper: {
    registerProvider: (p) => (registered = p),
    unregisterProvider: (id) => (unregistered = id)
  }
}

// 1. activate 注册 provider
plugin.activate(api).then(async () => {
  assert(registered, 'provider should be registered')
  assert.strictEqual(registered.id, 'kungal-catalog')
  assert.strictEqual(typeof registered.searchGames, 'function')
  assert.strictEqual(typeof registered.getGameMetadata, 'function')
  assert.strictEqual(typeof registered.getGameCovers, 'function')
  assert.strictEqual(typeof registered.getGameBackgrounds, 'function')
  console.log('OK: activate registers provider')

  // 2. 未配置 key -> 明确报错
  await assert.rejects(
    () => registered.searchGames('サクラノ刻'),
    /未配置 API Key/
  )
  console.log('OK: missing apiKey error')

  // 3. mock fetch: 401
  config.set('apiKey', 'nmk_test_bad')
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ code: 3, message: 'unauthorized' }) })
  await assert.rejects(() => registered.searchGames('サクラノ刻'), /鉴权失败/)
  console.log('OK: 401 error')

  // 4. mock fetch: search hits
  global.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/catalog/search')) {
      return {
        ok: true,
        json: async () => ({
          object: 'list',
          items: [
            { object: 'search_result', target_object: 'work', id: '12345', display_name: 'サクラノ刻',
              latin: 'sakura no toki', localized: { 'zh-Hans': { value: '樱之刻', is_machine: false } }, sources: ['vndb'], content_rating: 'r18' },
            { object: 'search_result', target_object: 'character', id: '999', display_name: 'someone' }
          ]
        })
      }
    }
    throw new Error('unexpected url: ' + u)
  }
  const list = await registered.searchGames('樱之刻')
  assert.strictEqual(list.length, 1, 'characters hit filtered out')
  assert.deepStrictEqual(list[0], { id: '12345', name: '樱之刻', releaseDate: '', developers: [''] })
  console.log('OK: searchGames maps hits, filters non-work, picks zh-Hans name')

  // 5. mock fetch: work detail
  global.fetch = async (url) => {
    const u = String(url)
    // resolveWorkId 对数字 id 先做存在性验证
    if (u.includes('/catalog/works/12345?nsfw=')) {
      return { ok: true, json: async () => ({ id: '12345' }) }
    }
    if (u.includes('/catalog/works/12345?include')) {
      return {
        ok: true,
        json: async () => ({
          id: '12345',
          display_name: 'サクラノ刻',
          localized: { 'zh-Hans': { value: '樱之刻', is_machine: false } },
          content_rating: 'r18',
          release_date: '2023-02-24',
          intros: [
            { lang: 'ja', value: '日本語の紹介。', is_machine: false, source: 'vndb' },
            { lang: 'zh-Hans', value: '这是中文简介。', is_machine: true, source: 'vndb' }
          ],
          releases: [
            { id: 'r1', date: '2023-02-24', title: 'サクラノ刻', platform: 'Windows', platforms: ['Windows'], release_kind: 'default' },
            { id: 'r2', date: null, title: 'demo' }
          ],
          ratings: [{ source: 'vndb', score: 8.35, vote_count: 4321 }, { source: 'bangumi', score: 8.7, vote_count: 100 }],
          tags: [{ id: 't1', display_name: '恋愛', is_sexual: false }, { id: 't2', display_name: '恋愛', is_sexual: false }],
          companies: [
            { id: 'c1', display_name: '枕', attribution_role: 'developer' },
            { id: 'c2', display_name: 'ねこにゃん', attribution_role: 'brand' },
            { id: 'c3', display_name: '发行商X', attribution_role: 'publisher' }
          ],
          links: [
            { source: 'vndb', url: 'https://vndb.org/v12345' },
            { source: 'vndb', url: 'https://vndb.org/v12346' }
          ]
        })
      }
    }
    throw new Error('unexpected url: ' + u)
  }
  const meta = await registered.getGameMetadata({ type: 'id', value: '12345' })
  assert.strictEqual(meta.name, '樱之刻')
  assert.strictEqual(meta.originalName, 'サクラノ刻')
  assert.strictEqual(meta.releaseDate, '2023-02-24')
  assert.strictEqual(meta.description, '这是中文简介。')
  assert.deepStrictEqual(meta.developers, ['枕', 'ねこにゃん'])
  assert.deepStrictEqual(meta.publishers, ['发行商X'])
  assert.deepStrictEqual(meta.tags, ['恋愛'])
  assert.deepStrictEqual(meta.platforms, ['Windows'])
  assert.deepStrictEqual(meta.relatedSites, [
    { label: 'KunGalgame', url: 'https://www.moyu.moe/galgame/12345' },
    { label: 'vndb', url: 'https://vndb.org/v12345' }
  ])
  assert.strictEqual(meta.extra[0].key, 'rating_vndb')
  console.log('OK: getGameMetadata maps detail (KunGalgame first, dup source deduped)')

  // 6. covers
  global.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/catalog/works/12345?nsfw=')) {
      return { ok: true, json: async () => ({ id: '12345' }) }
    }
    if (u.includes('/catalog/works/12345/covers')) {
      return { ok: true, json: async () => ({
        object: 'list',
        items: [
          { id: 'cv1', url: 'https://img.example/cv1.webp', portrait_pinned: false },
          { id: 'cv2', url: 'https://img.example/cv2.webp', portrait_pinned: true }
        ]
      }) }
    }
    throw new Error('unexpected url: ' + u)
  }
  const covers = await registered.getGameCovers({ type: 'id', value: '12345' })
  assert.deepStrictEqual(covers, ['https://img.example/cv1.webp', 'https://img.example/cv2.webp'])
  console.log('OK: getGameCovers reversed (last image first)')

  // 7. backgrounds
  global.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/catalog/works/12345?nsfw=')) {
      return { ok: true, json: async () => ({ id: '12345' }) }
    }
    if (u.includes('/catalog/works/12345/screenshots')) {
      return { ok: true, json: async () => ({ object: 'list', items: [{ url: 'https://img.example/ss1.webp' }] }) }
    }
    throw new Error('unexpected url: ' + u)
  }
  const bg = await registered.getGameBackgrounds({ type: 'id', value: '12345' })
  assert.deepStrictEqual(bg, ['https://img.example/ss1.webp'])
  console.log('OK: getGameBackgrounds')

  // 8. deactivate
  await plugin.deactivate(api)
  assert.strictEqual(unregistered, 'kungal-catalog')
  console.log('OK: deactivate unregisters provider')

  console.log('\nALL TESTS PASSED')
}).catch((e) => {
  console.error('TEST FAILED:', e)
  process.exit(1)
})
