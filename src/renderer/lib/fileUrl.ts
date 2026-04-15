const URL_SCHEME_RE = /^(file|https?|data|blob):/i
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:\//

export function toFileUrl(filePath: string | null | undefined): string {
  if (typeof filePath !== 'string') return ''

  const trimmedPath = filePath.trim()
  if (!trimmedPath) return ''

  if (URL_SCHEME_RE.test(trimmedPath)) {
    return trimmedPath
  }

  const normalizedPath = trimmedPath.replace(/\\/g, '/')
  const normalizedWithRoot = WINDOWS_DRIVE_RE.test(normalizedPath)
    ? `/${normalizedPath}`
    : normalizedPath.startsWith('/')
      ? normalizedPath
      : `/${normalizedPath}`

  return encodeURI(`file://${normalizedWithRoot}`)
}
