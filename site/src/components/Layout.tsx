import { useEffect } from "react"
import { Outlet, ScrollRestoration, useLocation } from "react-router-dom"
import ClickSpark from "./reactbits/ClickSpark"
import { SiteFooter } from "./SiteFooter"
import { SiteNav } from "./SiteNav"

export const Layout = () => {
  const { hash } = useLocation()

  // ScrollRestoration handles pages; in-page anchors from another route need a nudge.
  useEffect(() => {
    if (!hash) return
    document.querySelector(hash)?.scrollIntoView({ behavior: "smooth" })
  }, [hash])

  return (
    <ClickSpark sparkColor="#67e8f9" sparkCount={10} sparkRadius={22} duration={520}>
      <div className="flex min-h-dvh flex-col">
        <SiteNav />
        <main className="flex-1">
          <Outlet />
        </main>
        <SiteFooter />
      </div>
      <ScrollRestoration />
    </ClickSpark>
  )
}
