import type { ModelDocLink } from '@vis/protocol'
import type { ProviderType } from '../registry'
import { createOpenAIProvider } from './index'
import { OPENAI_ENDPOINTS, OPENAI_MODELS } from './params'

// RFC 0045: official pages, fetched and checked 2026-11-11. Links only; Agents read the current page.
const generateApi: ModelDocLink = { kind: 'api_reference', url: 'https://developers.openai.com/api/reference/resources/images/methods/generate' }
const openaiDocs = (id: string): ModelDocLink[] => [
  { kind: 'prompt_guide', url: `https://developers.openai.com/api/docs/guides/image-prompting#${id.startsWith('gpt-image-2.5') ? 'gpt-image-2.5-guide' : 'gpt-image-2-guide'}` },
  generateApi,
]

export const openaiProviderType: ProviderType = {
  type: 'openai',
  label: { zh: 'OpenAI 图片', en: 'OpenAI Images' },
  needsKey: true,
  kinds: ['image'],
  regions: [{ id: 'global', label: { zh: '全球', en: 'Global' }, baseUrl: 'https://api.openai.com/v1' }],
  allowCustomBaseUrl: true,
  endpoints: OPENAI_ENDPOINTS,
  knownModels: OPENAI_MODELS.map(id => ({ id, kind: 'image', label: id, docs: openaiDocs(id) })),
  help: {
    consoleUrl: 'https://platform.openai.com/api-keys',
    key: { zh: '在 OpenAI 控制台创建 API 密钥，部分模型需要组织验证。', en: 'Create an API key in the OpenAI console. Some models require organization verification.' },
    model: { zh: '使用 GPT Image 2.5 Sunburst、Flare 或 GPT Image 2 模型 ID，也可填写兼容网关的模型 ID。', en: 'Use a GPT Image 2.5 Sunburst, Flare or GPT Image 2 model ID, or a model ID from your compatible gateway.' },
  },
  availability: {
    zh: 'OpenAI 不向中国大陆、香港或澳门提供服务。使用自定义地址会将 API 密钥发送到该地址的主机。',
    en: 'OpenAI does not serve mainland China, Hong Kong or Macau. A custom URL sends your API key to that host.',
  },
  verified: false,
  create: (config, deps) => createOpenAIProvider({ ...config, ...deps }),
}
