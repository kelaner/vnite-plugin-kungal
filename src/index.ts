import type { IPlugin, IPluginAPI } from './types'
import { createKungalProvider, PROVIDER_ID } from './kungal'

const plugin: IPlugin = {
  async activate(api: IPluginAPI): Promise<void> {
    // 向 Vnite 刮削器注册中心注册数据源
    api.scraper.registerProvider(createKungalProvider(api))
  },

  async deactivate(api: IPluginAPI): Promise<void> {
    api.scraper.unregisterProvider(PROVIDER_ID)
  }
}

export default plugin
