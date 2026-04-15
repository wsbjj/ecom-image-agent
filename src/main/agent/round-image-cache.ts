import { app, nativeImage } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export interface RoundImageArtifacts {
  generatedImagePath: string
  previewImagePath: string | null
  contextThumbPath: string | null
}

interface PersistRoundArtifactsInput {
  taskId: string
  roundIndex: number
  sourceImagePath: string
}

const PREVIEW_WIDTH = 640
const CONTEXT_THUMB_WIDTH = 256

function resolveTaskAssetDir(taskId: string): string {
  return path.join(app.getPath('userData'), 'task_assets', taskId)
}

async function writeResizedImage(
  imagePath: string,
  outputPath: string,
  width: number,
): Promise<string | null> {
  try {
    const image = nativeImage.createFromPath(imagePath)
    if (image.isEmpty()) return null

    const size = image.getSize()
    const safeWidth = Math.max(1, Math.min(width, size.width))
    const safeHeight = Math.max(1, Math.round((size.height * safeWidth) / Math.max(1, size.width)))
    const resized = image.resize({ width: safeWidth, height: safeHeight, quality: 'good' })
    await fs.writeFile(outputPath, resized.toPNG())
    return outputPath
  } catch {
    return null
  }
}

async function writeCanonicalPng(
  sourceImagePath: string,
  outputPath: string,
): Promise<boolean> {
  try {
    const image = nativeImage.createFromPath(sourceImagePath)
    if (image.isEmpty()) {
      return false
    }
    await fs.writeFile(outputPath, image.toPNG())
    return true
  } catch {
    return false
  }
}

export async function persistRoundArtifacts(
  input: PersistRoundArtifactsInput,
): Promise<RoundImageArtifacts> {
  const assetDir = resolveTaskAssetDir(input.taskId)
  await fs.mkdir(assetDir, { recursive: true })

  let generatedPath = path.join(assetDir, `round_${input.roundIndex}_original.png`)
  const wroteCanonicalPng = await writeCanonicalPng(input.sourceImagePath, generatedPath)
  if (!wroteCanonicalPng) {
    const sourceExt = path.extname(input.sourceImagePath).trim().toLowerCase()
    const safeExt = sourceExt.length > 0 ? sourceExt : '.img'
    generatedPath = path.join(assetDir, `round_${input.roundIndex}_original${safeExt}`)
    await fs.copyFile(input.sourceImagePath, generatedPath)
  }

  const previewPath = path.join(assetDir, `round_${input.roundIndex}_preview.png`)
  const contextThumbPath = path.join(assetDir, `round_${input.roundIndex}_context.png`)

  const preview = await writeResizedImage(generatedPath, previewPath, PREVIEW_WIDTH)
  const contextThumb = await writeResizedImage(generatedPath, contextThumbPath, CONTEXT_THUMB_WIDTH)

  return {
    generatedImagePath: generatedPath,
    previewImagePath: preview,
    contextThumbPath: contextThumb,
  }
}

export async function pruneRoundOriginalCache(params: {
  taskId: string
  keepRoundIndexes: number[]
  maxOriginalRounds: number
}): Promise<void> {
  const assetDir = resolveTaskAssetDir(params.taskId)
  let entries: string[]
  try {
    entries = await fs.readdir(assetDir)
  } catch {
    return
  }

  const originalFiles = entries
    .map((name) => ({
      name,
      match: name.match(/^round_(\d+)_original\.[a-z0-9]+$/i),
    }))
    .filter((item): item is { name: string; match: RegExpMatchArray } => Boolean(item.match))
    .map((item) => ({
      name: item.name,
      roundIndex: Number.parseInt(item.match[1], 10),
    }))
    .sort((a, b) => a.roundIndex - b.roundIndex)

  if (originalFiles.length <= params.maxOriginalRounds) return

  const keepSet = new Set(params.keepRoundIndexes)
  const removable = originalFiles.filter((file) => !keepSet.has(file.roundIndex))

  const overflowCount = Math.max(0, originalFiles.length - params.maxOriginalRounds)
  const toDelete = removable.slice(0, overflowCount)

  await Promise.all(
    toDelete.map(async (item) => {
      const originalPath = path.join(assetDir, item.name)
      // 只清理原图，保留 preview/context 缩略图用于时间线与历史上下文索引。
      await fs.rm(originalPath, { force: true })
    }),
  )
}
