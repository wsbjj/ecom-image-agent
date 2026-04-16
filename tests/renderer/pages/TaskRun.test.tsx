import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TaskRun } from '../../../src/renderer/pages/TaskRun'
import { useAgentStore } from '../../../src/renderer/store/agent.store'

vi.mock('../../../src/renderer/components/TerminalPane', () => ({
  TerminalPane: () => <div data-testid="terminal-pane" />,
}))

vi.mock('../../../src/renderer/components/CsvImporter', () => ({
  CsvImporter: () => <div data-testid="csv-importer" />,
}))

vi.mock('../../../src/renderer/components/ScoreGauge', () => ({
  ScoreGauge: () => <div data-testid="score-gauge" />,
}))

vi.mock('../../../src/renderer/components/ImageUploadZone', () => ({
  ImageUploadZone: () => <div data-testid="image-upload-zone" />,
}))

function buildRoundPreview(roundIndex: number) {
  return {
    roundIndex,
    generatedImagePath: `/tmp/generated-${roundIndex + 1}.png`,
    previewImagePath: `/tmp/preview-${roundIndex + 1}.png`,
    score: 90 + roundIndex,
    timestamp: Date.now() + roundIndex,
  }
}

describe('TaskRun round preview timeline', () => {
  beforeEach(() => {
    useAgentStore.setState({
      activeTaskId: null,
      currentPhase: null,
      currentScore: null,
      retryCount: 0,
      costUsd: 0,
      contextUsage: null,
      roundPreviews: [],
      logLines: [],
      isRunning: false,
    })

    vi.mocked(window.api.getConfigValue).mockResolvedValue({ value: null })
    vi.mocked(window.api.listEvaluationTemplates).mockResolvedValue([
      {
        id: 1,
        name: 'Default',
        version: 1,
        default_threshold: 85,
        rubric_json: '{}',
        created_at: new Date().toISOString(),
      },
    ])
    vi.mocked(window.api.readImageAsDataUrl).mockResolvedValue({ dataUrl: null })
  })

  it('renders compact clickable thumbnails and opens preview dialog', async () => {
    useAgentStore.setState({
      roundPreviews: [buildRoundPreview(0), buildRoundPreview(1)],
    })

    render(<TaskRun />)

    const timeline = await screen.findByTestId('round-preview-timeline')
    expect(timeline).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Open round 1 preview' }))

    expect(screen.getByRole('dialog', { name: 'Round 1 image preview' })).toBeInTheDocument()
  })

  it('closes preview dialog by overlay click, close button, and Escape key', async () => {
    useAgentStore.setState({
      roundPreviews: [buildRoundPreview(0)],
    })

    render(<TaskRun />)

    const user = userEvent.setup()
    const openButton = await screen.findByRole('button', { name: 'Open round 1 preview' })

    await user.click(openButton)
    expect(screen.getByRole('dialog', { name: 'Round 1 image preview' })).toBeInTheDocument()

    await user.click(screen.getByTestId('round-preview-overlay'))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Round 1 image preview' })).not.toBeInTheDocument()
    })

    await user.click(openButton)
    await user.click(screen.getByRole('button', { name: 'Close preview' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Round 1 image preview' })).not.toBeInTheDocument()
    })

    await user.click(openButton)
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Round 1 image preview' })).not.toBeInTheDocument()
    })
  })

  it('shows empty placeholder when no round previews exist', async () => {
    render(<TaskRun />)

    expect(await screen.findByTestId('round-preview-empty')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Open round/i })).not.toBeInTheDocument()
  })
})
