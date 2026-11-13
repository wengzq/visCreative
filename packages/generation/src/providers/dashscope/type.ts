import type { ModelDocLink } from '@vis/protocol'
import type { ProviderType } from '../registry'
import { createDashScopeProvider, DASHSCOPE_ENDPOINTS, DASHSCOPE_REGIONS } from './index'
import { DASHSCOPE_MODELS } from './models'

// RFC 0045: official pages, fetched and checked 2026-11-11. Links only; Agents read the current page.
const HELP = 'https://www.alibabacloud.com/help/en/model-studio/'
const wan27Guide: ModelDocLink = { kind: 'prompt_guide', url: `${HELP}text-to-video-prompt` }
const dashscopeDocs = (id: string): ModelDocLink[] => {
  if (id.startsWith('wan2.7-t2v')) return [wan27Guide, { kind: 'api_reference', url: `${HELP}text-to-video-api-reference` }]
  if (id.startsWith('wan2.7-i2v')) return [wan27Guide, { kind: 'api_reference', url: `${HELP}image-to-video-general-api-reference` }]
  if (id.startsWith('wan2.7-r2v')) return [wan27Guide, { kind: 'api_reference', url: `${HELP}wan-video-to-video-api-reference` }]
  if (id.startsWith('wan3.0-video')) return [{ kind: 'prompt_guide', url: `${HELP}wan3-video-generation-prompt-guide` }, { kind: 'api_reference', url: `${HELP}wan3-video-generation-api-reference` }]
  if (id.startsWith('wan2.7-image')) return [{ kind: 'prompt_guide', url: `${HELP}text-to-image-prompt` }, { kind: 'api_reference', url: `${HELP}wan-image-generation-and-editing-api-reference` }]
  return [] // an unmapped model fails the RFC 0045 registry test
}

export const dashscopeProviderType: ProviderType = {
  type: 'dashscope',
  label: { zh: '阿里云百炼 (万相)', en: 'Alibaba Wan (DashScope)' },
  needsKey: true,
  kinds: ['image', 'video'],
  regions: DASHSCOPE_REGIONS,
  allowCustomBaseUrl: true,
  endpoints: DASHSCOPE_ENDPOINTS,
  knownModels: DASHSCOPE_MODELS.map(({ id, label, kind }) => ({ id, label, kind, docs: dashscopeDocs(id) })),
  help: {
    consoleUrl: 'https://bailian.console.aliyun.com/',
    key: {
      zh: '在所选地区的百炼控制台创建 API Key。密钥与地区绑定，不能跨地区使用。预设北京和新加坡，其他地址可填自定义地址。',
      en: 'Create an API key in the Model Studio console for the selected region. Keys are region-bound and cannot be used across regions. Beijing and Singapore are preset; use a custom URL for other hosts.',
    },
    model: {
      zh: '选择已支持的 wan2.7 或 wan3.0 模型，并确认该模型在所选地区可用。wan3.0 只在工作空间专属域名上提供：在百炼控制台复制形如 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1 的地址，填为自定义地址。视频与音频参考暂不支持。',
      en: 'Choose a supported wan2.7 or wan3.0 model and confirm availability in the selected region. wan3.0 is served only from workspace hosts: copy the address shaped like https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1 from the Model Studio console and enter it as a custom URL. Video and audio references are not supported yet.',
    },
  },
  availability: {
    zh: '本服务尚未经真实 API 验证。美国和欧盟的工作空间专用域名可填为自定义地址，尚未验证。使用自定义地址会将 API 密钥发送到该地址的主机。任务记录和输出链接仅保留 24 小时。',
    en: 'This service has not been verified against the real API. US and EU workspace-specific domains can be entered as a custom URL but are unverified. A custom URL sends your API key to that host. Task records and output URLs last only 24 hours.',
  },
  verified: false,
  create: (config, deps) => createDashScopeProvider({ ...config, ...deps }),
}
