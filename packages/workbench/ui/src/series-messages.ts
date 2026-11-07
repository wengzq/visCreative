import { defineMessages } from '@vis/ui-kit'

export const seriesProjectMessages = defineMessages({
  standalone: '独立项目', newEpisode: '作为系列的新一集', series: '系列', newSeries: '新建系列…',
  seriesName: '系列名称', episode: '集数', episodeLabel: (number: string) => `第 ${number} 集`,
  episodeCount: (number: string) => `${number} 集`, join: '加入系列…', joinTitle: '加入系列',
  leave: '离开系列', leaveTitle: '离开系列？', leaveNote: '所有设定都会保留在本集，成为本集独立的设定。',
  changeEpisode: '修改集数', publishSettings: '同时发布到系列的设定',
  emptySettings: '本集还没有设定。', joinNote: '所选设定将发布到系列，其他集可选择使用。',
  failed: (name: string, code: string) => `${name}未能发布：${code}`,
  joinedWithFailures: '已加入系列，但以下设定未能发布。请在设定编辑器中重试。',
  save: '保存', cancel: '取消', close: '关闭', loading: '加载中…',
  delete: '删除系列', deleteTitle: '删除系列？', deleteNote: '所有集和设定都会保留，各集将成为独立项目。',
}, {
  standalone: 'Standalone project', newEpisode: 'New episode of a series', series: 'Series', newSeries: 'New series…',
  seriesName: 'Series name', episode: 'Episode number', episodeLabel: (number: string) => `Episode ${number}`,
  episodeCount: (number: string) => `${number} episodes`, join: 'Join series…', joinTitle: 'Join a series',
  leave: 'Leave series', leaveTitle: 'Leave this series?', leaveNote: 'All settings stay in this episode as standalone settings.',
  changeEpisode: 'Change episode number', publishSettings: 'Settings to publish to the series',
  emptySettings: 'This episode has no settings yet.', joinNote: 'Selected settings will be published to the series for other episodes to use.',
  failed: (name: string, code: string) => `Could not publish ${name}: ${code}`,
  joinedWithFailures: 'Joined the series, but some settings could not be published. Retry in the setting editor.',
  save: 'Save', cancel: 'Cancel', close: 'Close', loading: 'Loading…',
  delete: 'Delete series', deleteTitle: 'Delete this series?', deleteNote: 'All episodes and their settings are kept. Episodes become standalone projects.',
})
