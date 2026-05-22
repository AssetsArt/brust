import { createElement, type ComponentType } from "react"
import HelloWorld from "./components/HelloWorld"

export interface Page {
  component: ComponentType<{ workerId: string }>
}

// path → Page. The runtime is told which path-strings the host registered,
// in order, and looks up each path here.
const PAGES_BY_PATH: Record<string, Page> = {
  "/": { component: HelloWorld },
}

const ROUTE_ID_TO_PAGE = new Map<number, Page>()

export function bindRoutes(routes: string[]): void {
  ROUTE_ID_TO_PAGE.clear()
  routes.forEach((path, id) => {
    const page = PAGES_BY_PATH[path]
    if (!page) {
      throw new Error(`unknown route in registry: ${path}`)
    }
    ROUTE_ID_TO_PAGE.set(id, page)
  })
}

export function getPage(routeId: number): Page {
  const page = ROUTE_ID_TO_PAGE.get(routeId)
  if (!page) {
    throw new Error(`no page for route_id ${routeId}`)
  }
  return page
}

export { createElement }
