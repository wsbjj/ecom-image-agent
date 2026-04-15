import pLimit, { type LimitFunction } from 'p-limit'

const DEFAULT_CONCURRENCY = 3

let limiter: LimitFunction = pLimit(DEFAULT_CONCURRENCY)

export function getTaskLimiter(): LimitFunction {
  return limiter
}

export function setConcurrency(concurrency: number): void {
  limiter = pLimit(Math.max(1, concurrency))
}
