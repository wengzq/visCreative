import { defineMessages } from '@vis/ui-kit'

export const sceneMessages = defineMessages({
  create: '新建 3D 场景',
  scene: '3D 场景',
  open: '打开场景',
  empty: '打开场景，添加人物或物体',
  noStill: '此视图尚未保存画面',
  views: (count: string) => `${count} 个视图`,
  label: (name: string, count: string) => `${name} · ${count} 个视图`,
}, {
  create: 'New 3D scene',
  scene: '3D scene',
  open: 'Open scene',
  empty: 'Open the scene to add figures or objects',
  noStill: 'No saved frame for this view',
  views: (count: string) => `${count} views`,
  label: (name: string, count: string) => `${name} · ${count} views`,
})
