/**
 * 精简类型声明，摘自官方 vnite-plugin-sdk（https://github.com/ximu3/vnite-plugin-sdk）。
 * 仅保留本插件使用到的面；如需完整 API 类型，请以 npm 包 vnite-plugin-sdk 为准。
 */

export interface IPluginDB {
  getValue(key: string, defaultValue?: any): Promise<any>
  setValue(key: string, value: any): Promise<void>
}

export interface IScraperManager {
  registerProvider(provider: ScraperProvider): void
  unregisterProvider(providerId: string): void
}

/** Vnite 主进程注入给插件的 API 对象（activate 的入参） */
export interface IPluginAPI {
  readonly pluginId: string
  readonly PluginDB: IPluginDB
  readonly scraper: IScraperManager
}

export type GameList = Array<{
  id: string
  name: string
  releaseDate: string
  developers: string[]
}>

export interface GameMetadata {
  name: string
  originalName: string | null
  releaseDate: string
  description: string
  developers: string[]
  relatedSites: Array<{ label: string; url: string }>
  tags: string[]
  publishers?: string[]
  genres?: string[]
  platforms?: string[]
  extra?: Array<{ key: string; value: string[] }>
}

export type ScraperIdentifier = {
  type: 'id' | 'name'
  value: string
}

export interface ScraperProvider {
  id: string
  name: string

  searchGames?(gameName: string, gamePath?: string): Promise<GameList>
  checkGameExists?(identifier: ScraperIdentifier): Promise<boolean>
  getGameMetadata?(identifier: ScraperIdentifier): Promise<GameMetadata>
  getGameWideCovers?(identifier: ScraperIdentifier): Promise<string[]>
  getGameBackgrounds?(identifier: ScraperIdentifier): Promise<string[]>
  getGameCovers?(identifier: ScraperIdentifier): Promise<string[]>
  getGameLogos?(identifier: ScraperIdentifier): Promise<string[]>
  getGameIcons?(identifier: ScraperIdentifier): Promise<string[]>
}

export interface IPlugin {
  activate(api: IPluginAPI): Promise<void> | void
  deactivate?(api: IPluginAPI): Promise<void> | void
}
