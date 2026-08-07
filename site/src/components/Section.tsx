import { type ReactNode, useEffect, useRef, useState } from "react"

interface SectionProps {
  readonly id?: string
  readonly children: ReactNode
  readonly className?: string
}

export const Section = ({ id, children, className = "" }: SectionProps) => (
  <section id={id} className={`px-gutter py-section ${className}`}>
    <div className="mx-auto max-w-6xl">{children}</div>
  </section>
)

interface RevealProps {
  readonly children: ReactNode
  /** Seconds to stagger this element behind its neighbours. */
  readonly delay?: number
  readonly className?: string
}

/**
 * One scroll-reveal setting for the whole site, so nothing animates out of character.
 *
 * Deliberately CSS rather than GSAP: a rAF-driven timeline stalls when the tab is in the
 * background and can leave body copy stranded at half opacity. A class flip always lands
 * on its end state, and `prefers-reduced-motion` collapses the transition to nothing.
 */
export const Reveal = ({ children, delay = 0, className = "" }: RevealProps) => {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown(true)
          observer.disconnect()
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    )

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      style={{ transitionDelay: `${delay}s` }}
      className={`transition duration-(--duration-slow) ease-(--ease-out-soft) ${
        shown ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
      } ${className}`}
    >
      {children}
    </div>
  )
}

interface EyebrowProps {
  readonly children: ReactNode
}

export const Eyebrow = ({ children }: EyebrowProps) => (
  <p className="flex items-center gap-3 font-mono text-xs tracking-[0.2em] text-beam uppercase">
    <span className="beam-rule inline-block h-px w-8" aria-hidden="true" />
    {children}
  </p>
)

interface SectionTitleProps {
  readonly children: ReactNode
  readonly className?: string
}

export const SectionTitle = ({ children, className = "" }: SectionTitleProps) => (
  <h2 className={`mt-5 max-w-3xl text-title font-semibold text-balance ${className}`}>
    {children}
  </h2>
)

interface LeadProps {
  readonly children: ReactNode
}

export const Lead = ({ children }: LeadProps) => (
  <p className="mt-5 max-w-2xl text-lead text-ink-muted text-pretty">{children}</p>
)
