import type { ProviderType } from '../registry'
import { createKlingProvider, KLING_ENDPOINTS, KLING_REGIONS } from './index'
import { KLING_MODELS } from './models'

export const klingProviderType: ProviderType = {
  type: 'kling',
  label: { zh: '可灵', en: 'Kling AI' },
  needsKey: true,
  kinds: ['video', 'image'],
  regions: KLING_REGIONS,
  allowCustomBaseUrl: true,
  endpoints: KLING_ENDPOINTS,
  knownModels: KLING_MODELS.map(({ id, label, kind }) => ({ id, label, kind })),
  help: {
    consoleUrl: 'https://kling.ai/dev/api-key',
    key: { zh: '在所选地区的可灵控制台创建 API Key。', en: 'Create an API key in the Kling console for the selected region.' },
    model: { zh: '选择已支持的模型；视频使用新版路径模型 ID，图片使用 kling-v3-omni。', en: 'Choose a supported model: video uses the current path model IDs; images use kling-v3-omni.' },
  },
  availability: {
    zh: '选择与账户平台一致的地区；跨地区密钥通用性尚未验证。使用自定义地址会将 API 密钥发送到该地址的主机。本服务尚未经真实 API 验证。',
    en: 'Select the region matching your account platform; cross-region key portability is unverified. A custom URL sends your API key to that host. This service has not been verified against the real API.',
  },
  verified: false,
  create: (config, deps) => createKlingProvider({ ...config, ...deps }),
}
