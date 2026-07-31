import { describe, expect, it } from 'vitest'

import { parseServerEnv } from './env-schema'

const validEnv = {
  POSTGRES_URL: 'postgresql://user:password@localhost:5432/ai_chatbot',
  AUTH_SECRET: 'a-secure-test-secret-with-32-characters',
  DEEPSEEK_API_KEY: 'test-api-key',
}

describe('parseServerEnv', () => {
  it('accepts a complete server environment', () => {
    expect(parseServerEnv(validEnv)).toEqual(validEnv)
  })

  it('reports every missing required variable', () => {
    expect(() => parseServerEnv({})).toThrow('POSTGRES_URL')
    expect(() => parseServerEnv({})).toThrow('AUTH_SECRET')
    expect(() => parseServerEnv({})).toThrow('DEEPSEEK_API_KEY')
  })
})
