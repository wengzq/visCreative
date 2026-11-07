import { createFfmpegMedia } from '@vis/assets'
import { providerContract } from '../contract'
import { exampleService, EXAMPLE_SECRET } from './example'

providerContract('Example', async scenario => {
  const service = await exampleService(scenario)
  return {
    adapter: service.type.create({ id: 'example', type: 'example', label: 'Example', baseUrl: `${service.origin}/east`, imageModels: [{ id: 'example-image', label: 'Example Image' }], videoModels: [], audioModels: [] }, { dataDir: '', getKey: async () => EXAMPLE_SECRET, media: createFfmpegMedia() }),
    request: { kind: 'image', operation: 'generate', model: 'example-image', prompt: 'Contract', inputs: [], params: {} },
    secret: EXAMPLE_SECRET, creates: service.creates, recoversLost: true,
    output: { outputIndex: 0, ref: `${service.origin}/output` }, close: service.close,
  }
})
