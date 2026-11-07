import { defineMessages } from '@vis/ui-kit'

export const sceneHostMessages = defineMessages({
  scene: '3D 场景',
  loading: '正在打开场景…',
  close: '关闭场景',
  model: (number: string) => `模型 ${number}`,
  panelMissing: '画格已删除',
  imageOnly: '场景画面必须是图片',
  modelOnly: '请选择 GLB 模型文件',
}, {
  scene: '3D scene',
  loading: 'Opening scene…',
  close: 'Close scene',
  model: (number: string) => `Model ${number}`,
  panelMissing: 'The panel has been deleted',
  imageOnly: 'Scene frames require an image',
  modelOnly: 'Choose a GLB model file',
})
