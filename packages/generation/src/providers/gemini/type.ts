import type { ProviderType } from '../registry'
import { createGeminiProvider } from './index'
import { GEMINI_BASE_URL, GEMINI_ENDPOINTS, GEMINI_MODELS } from './models'

export const geminiProviderType: ProviderType = {
  type: 'gemini',
  label: { zh: 'Google Gemini', en: 'Google Gemini' },
  needsKey: true,
  kinds: ['image', 'video'],
  regions: [{ id: 'global', label: { zh: '全球', en: 'Global' }, baseUrl: GEMINI_BASE_URL }],
  allowCustomBaseUrl: true,
  endpoints: GEMINI_ENDPOINTS,
  knownModels: GEMINI_MODELS.map(({ id, label, kind }) => ({ id, label, kind })),
  help: {
    consoleUrl: 'https://aistudio.google.com/api-keys',
    key: { zh: '在 Google AI Studio 创建 Gemini API 密钥。', en: 'Create a Gemini API key in Google AI Studio.' },
    model: { zh: '图片使用 Nano Banana 模型；视频使用 gemini-omni-1.1-flash。', en: 'Use Nano Banana models for images and gemini-omni-1.1-flash for video.' },
  },
  availability: {
    zh: '本服务不向中国大陆、香港或澳门提供服务，且尚未经真实 API 验证。使用自定义地址会将 API 密钥发送到该地址的主机。',
    en: 'This service is not offered in mainland China, Hong Kong or Macau and has not been verified against the real API. A custom URL sends your API key to that host.',
  },
  verified: false,
  create: (config, deps) => createGeminiProvider({ ...config, ...deps }),
}
