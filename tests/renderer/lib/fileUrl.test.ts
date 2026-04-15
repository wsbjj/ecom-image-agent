import { describe, it, expect } from 'vitest'
import { toFileUrl } from '../../../src/renderer/lib/fileUrl'

describe('toFileUrl', () => {
  it('returns empty string for undefined path', () => {
    expect(toFileUrl(undefined)).toBe('')
  })

  it('converts windows path to encoded file URL', () => {
    expect(toFileUrl('C:\\Users\\test\\产品图 1.png')).toBe(
      'file:///C:/Users/test/%E4%BA%A7%E5%93%81%E5%9B%BE%201.png',
    )
  })
})
