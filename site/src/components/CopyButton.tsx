import { useEffect, useState } from "react"

interface CopyButtonProps {
  readonly value: string
  readonly label?: string
  readonly className?: string
}

export const CopyButton = ({ value, label = "Copy", className = "" }: CopyButtonProps) => {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = () => {
    // Clipboard access is denied outside a secure context; a failed copy must not throw.
    void navigator.clipboard
      ?.writeText(value)
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`${label} to clipboard`}
      className={`cursor-pointer rounded-md border border-line/70 bg-surface/80 px-2.5 py-1 font-mono text-[11px] tracking-wide text-ink-muted transition-colors duration-(--duration-quick) hover:border-beam/50 hover:text-beam ${className}`}
    >
      {copied ? "copied" : label}
    </button>
  )
}
