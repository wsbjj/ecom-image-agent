import type { ImageProvider } from './providers/base'

const REGISTRY = new Map<string, ImageProvider>()

export function registerProvider(provider: ImageProvider): void {
  REGISTRY.set(provider.name, provider)
}

export function getProvider(name: string): ImageProvider {
  const provider = REGISTRY.get(name)
  if (!provider) {
    throw new Error(`未知 provider: ${name}`)
  }
  return provider
}

export function hasProvider(name: string): boolean {
  return REGISTRY.has(name)
}
