import { createBrowserRouter, Navigate } from "react-router-dom"
import { Layout } from "./components/Layout"
import { Home } from "./pages/Home"
import { NotFound } from "./pages/NotFound"

export const router = createBrowserRouter(
  [
    {
      element: <Layout />,
      children: [
        { index: true, element: <Home /> },
        {
          path: "docs",
          // The markdown renderer only loads for someone who actually opens the docs.
          lazy: async () => {
            const { DocsLayout } = await import("./pages/DocsLayout")
            return { Component: DocsLayout }
          },
          children: [
            { index: true, element: <Navigate to="/docs/overview" replace /> },
            {
              path: ":slug",
              lazy: async () => {
                const { DocPageView } = await import("./pages/DocPageView")
                return { Component: DocPageView }
              },
            },
          ],
        },
        { path: "*", element: <NotFound /> },
      ],
    },
  ],
  // Vite's base and the router's basename must agree, in dev and in the built site alike.
  { basename: import.meta.env.BASE_URL },
)
