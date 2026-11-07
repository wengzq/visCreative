import { describe, expect, it } from 'vitest'
import { describeError } from './errors'
import { defineMessages, detectLocale, formatter, messagesFor } from './i18n'

describe('UI language (0018)', () => {
  it('uses the first Chinese or English browser-preferred language; defaults to English if neither appears', () => {
    expect(detectLocale(['zh-TW', 'en'])).toBe('zh-CN')
    expect(detectLocale(['fr-FR', 'en-GB', 'zh-CN'])).toBe('en')
    expect(detectLocale(['ja'])).toBe('en')
    expect(detectLocale([])).toBe('en')
  })

  it('dictionaries select values by language; function values handle interpolation', () => {
    const dictionary = defineMessages({ close: '关闭', files: (n: number) => `${n} 个文件` }, { close: 'Close', files: n => `${n} file${n === 1 ? '' : 's'}` })
    expect(messagesFor(dictionary, 'zh-CN').files(2)).toBe('2 个文件')
    expect(messagesFor(dictionary, 'en').files(1)).toBe('1 file')
    expect(messagesFor(dictionary, 'en').close).toBe('Close')
  })

  it('errors: Chinese UI uses originals; English UI falls back to error-code descriptions for Chinese originals', () => {
    // english-exempt: Chinese backend diagnostic fixture tests locale-specific fallback behavior.
    const error = { message: '同名 skill 已存在', data: { code: 'invalid_params' } }
    expect(describeError(error, 'zh-CN')).toBe('同名 skill 已存在')
    expect(describeError(error, 'en')).toBe('Invalid request')
    expect(describeError(new Error('network down'), 'en')).toBe('network down')
    // english-exempt: Chinese unknown-error fixture tests locale-specific fallback behavior.
    expect(describeError({ message: '未知', data: {} }, 'en')).toBe('Something went wrong')
  })

  it('numbers, bytes, and times format by language', () => {
    expect(formatter('en').number(12345)).toBe('12,345')
    expect(formatter('en').bytes(1536)).toBe('1.5 KB')
    expect(formatter('en').bytes(0)).toBe('0 B')
    expect(formatter('zh-CN').bytes(2 * 1024 ** 3)).toBe('2 GB')
    expect(formatter('en').relativeTime(0, 3 * 60_000)).toBe('3 minutes ago')
    expect(formatter('zh-CN').relativeTime(0, 3 * 60_000)).toBe('3分钟前')
  })
})
