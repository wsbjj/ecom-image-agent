interface ScoreGaugeProps {
  score: number | null
  size?: number
  passThreshold?: number
}

export function ScoreGauge({ score, size = 120, passThreshold = 85 }: ScoreGaugeProps) {
  const radius = (size - 12) / 2
  const circumference = 2 * Math.PI * radius
  const normalizedScore = score ?? 0
  const offset = circumference - (normalizedScore / 100) * circumference

  const getColor = (s: number): string => {
    const normalizedThreshold = Math.min(100, Math.max(0, passThreshold))
    const warningThreshold = Math.max(0, normalizedThreshold - 25)
    if (s >= normalizedThreshold) return '#10b981'
    if (s >= warningThreshold) return '#f59e0b'
    return '#ef4444'
  }

  const color = getColor(normalizedScore)

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#374151"
          strokeWidth="6"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-all duration-700 ease-out"
        />
      </svg>
      <div
        className="absolute flex flex-col items-center justify-center"
        style={{ width: size, height: size }}
      >
        <span className="text-2xl font-bold text-gray-100">
          {score !== null ? score : '--'}
        </span>
        <span className="text-xs text-gray-500">/ 100</span>
      </div>
    </div>
  )
}
