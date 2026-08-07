interface BeamMarkProps {
  readonly className?: string
}

/** A box with a beam passing through it — the whole product in 24 pixels. */
export const BeamMark = ({ className = "" }: BeamMarkProps) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none">
    <title>beambox</title>
    <path
      d="M4 7.2 12 3l8 4.2v9.6L12 21l-8-4.2V7.2Z"
      stroke="currentColor"
      strokeOpacity="0.45"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
    <path d="M2 12h20" stroke="url(#beam-mark-gradient)" strokeWidth="2" strokeLinecap="round" />
    <circle cx="12" cy="12" r="2.4" fill="url(#beam-mark-gradient)" />
    <defs>
      <linearGradient id="beam-mark-gradient" x1="2" y1="12" x2="22" y2="12">
        <stop stopColor="var(--color-beam)" stopOpacity="0.2" />
        <stop offset="0.5" stopColor="var(--color-beam)" />
        <stop offset="1" stopColor="var(--color-flux)" stopOpacity="0.2" />
      </linearGradient>
    </defs>
  </svg>
)
