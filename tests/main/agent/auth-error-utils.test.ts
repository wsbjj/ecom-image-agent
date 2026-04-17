import { describe, expect, it } from 'vitest'
import { parseAuthFailure } from '../../../src/main/agent/auth-error-utils'

describe('parseAuthFailure', () => {
  it('prefers provider inferred from raw error over provider hint', () => {
    const parsed = parseAuthFailure(
      'Error: 400 {"code":10007,"msg":"Bad Request: [model \'claude-haiku-4-5-20251001\' is not available in your coding plan]"}',
      {
        providerHint: 'seedream-visual',
        tool: null,
      },
    )

    expect(parsed).not.toBeNull()
    expect(parsed?.provider).toBe('anthropic')
    expect(parsed?.statusCode).toBe(400)
    expect(parsed?.hint).toContain('Coding plan')
  })

  it('normalizes provider hint names', () => {
    const parsed = parseAuthFailure('AxiosError: Request failed with status code 401', {
      providerHint: 'seedream-visual',
      tool: 'generate_image',
    })

    expect(parsed).not.toBeNull()
    expect(parsed?.provider).toBe('seedream')
    expect(parsed?.statusCode).toBe(401)
  })
})
