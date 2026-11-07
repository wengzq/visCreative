import { describe, expect, it } from 'vitest'
import { formatter, messagesFor } from '@vis/ui-kit'
import * as dictionaries from './messages'
import { controlMessages, mediaMessages, messages } from './messages'

describe('Chinese and English canvas copy', () => {
  it('The English dictionary has no empty strings and shares the Chinese keys', () => {
    for (const dictionary of Object.values(dictionaries)) {
      expect(Object.keys(dictionary.en).sort()).toEqual(Object.keys(dictionary['zh-CN']).sort())
      for (const value of Object.values(dictionary.en)) {
        if (typeof value === 'string') expect(value.trim()).not.toBe('')
      }
    }
  })

  it('Count interpolation preserves Chinese punctuation and provides English descriptions', () => {
    expect(messagesFor(messages, 'zh-CN').deleteContents(formatter('zh-CN').number(2))).toBe('另外选中的 2 个内容节点也会删除。')
    expect(messagesFor(messages, 'en').deleteContents(formatter('en').number(2))).toBe('The other 2 selected content nodes will also be deleted.')
    expect(messagesFor(messages, 'zh-CN').moreProblems('2')).toBe('（另有 2 条）')
    expect(messagesFor(messages, 'en').moreProblems('2')).toBe(' (2 more)')
  })

  it('Dimension interpolation preserves technical values and timecodes without digit grouping', () => {
    expect(messagesFor(mediaMessages, 'zh-CN').dimensions(2048, 1152, '0:05')).toBe('2048×1152 · 0:05')
    expect(messagesFor(mediaMessages, 'en').dimensions(2048, 1152)).toBe('2048×1152')
  })

  it('Category suggestions follow the language; inserted user titles remain verbatim', () => {
    expect(messagesFor(messages, 'zh-CN').characters).toBe('人物')
    expect(messagesFor(messages, 'en').characters).toBe('Characters')
    expect(messagesFor(messages, 'en').deleteFrameHint('我的框')).toBe('Deleting “我的框” will keep the nodes inside it.')
  })
})


it('Built-in model descriptions are translated; custom labels and descriptions remain verbatim', () => {
  const en = messagesFor(controlMessages, 'en')
  const zh = messagesFor(controlMessages, 'zh-CN')
  expect(en.providerLabel('render', '本机代码渲染')).toBe('Local code rendering')
  expect(en.modelLabel('mock-music-1', 'Mock 音乐')).toBe('Mock Music')
  expect(en.modelLabel('mock-sfx-1', 'Mock 音效')).toBe('Mock Sound Effects')
  expect(en.modelLabel('mock-music-1', '我的模型')).toBe('我的模型')
  expect(en.parameterDescription('视频分辨率：480p / 720p')).toBe('Video resolution: 480p / 720p')
  expect(en.parameterDescription('音乐秒数，5–60')).toBe('Music duration in seconds, 5–60')
  expect(en.parameterDescription('My custom hint')).toBe('My custom hint')
  expect(zh.parameterDescription('音乐秒数，5–60')).toBe('音乐秒数，5–60')
  expect(en.parameterLabel('seed')).toBe('Seed')
  expect(zh.parameterLabel('seed')).toBe('随机种子')
})
