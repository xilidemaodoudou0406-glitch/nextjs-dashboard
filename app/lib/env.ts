import { parseServerEnv } from './env-schema'

export const env = parseServerEnv(process.env)
