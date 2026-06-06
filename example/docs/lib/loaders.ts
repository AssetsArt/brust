// Per-page loaders. Each leaf loader returns the CHROME fields the native Layout
// destructures (title, mode, nav, version, repo, prev/next) PLUS the page's
// server-highlighted code samples and reference-table data. Code is highlighted
// HERE (server-side Prism) and injected via dangerouslySetInnerHTML in CodeBlock
// → `{{ (html) | safe }}`, so every sample ships as static HTML with zero client
// JS. Snippets/tables live in ./snippets and ./tables; behavior sources live in
// their component files (gap G5). Everything uses the REAL brust API.
import { source as clockSource } from '../components/Clock'
import { source as counterSource } from '../components/Counter'
import { source as playgroundSource } from '../components/Playground'
import { source as toggleSource } from '../components/Toggle'
import { highlightCode } from './highlight'
import { NAV, navFor, prevNextFor, REPO } from './nav'
import { S } from './snippets'
import * as T from './tables'
import { VERSION } from './version'

const hl = highlightCode

/** Shared chrome for every page: title + nav (with server-computed active state)
 * + prev/next pager + brand metadata. `active` is the route path. */
function chrome(active: string, title: string) {
  return {
    title,
    mode: 'dark' as const,
    version: VERSION,
    repo: REPO,
    nav: navFor(active),
    ...prevNextFor(active),
  }
}

// ── Home (standalone — renders its own chrome) ─────────────────────────────────
export async function homeLoader() {
  return {
    title: 'brust — fast SSR for Bun + Rust',
    mode: 'dark' as const,
    version: VERSION,
    repo: REPO,
    heroHtml: hl(S.heroRoutes, 'tsx'),
    counterHtml: hl(counterSource, 'tsx'),
  }
}

// ── Getting Started ────────────────────────────────────────────────────────────
export async function introductionLoader() {
  return {
    ...chrome('/docs/introduction', 'Introduction · brust'),
    bootHtml: hl(S.boot, 'tsx'),
  }
}
export async function installationLoader() {
  return {
    ...chrome('/docs/installation', 'Installation · brust'),
    scaffoldHtml: hl(S.scaffold, 'bash'),
    addHtml: hl(S.addExisting, 'bash'),
    pkgHtml: hl(S.pkgScripts, 'json'),
  }
}
export async function projectStructureLoader() {
  return {
    ...chrome('/docs/project-structure', 'Project structure · brust'),
    treeHtml: hl(S.layoutTree, 'bash'),
    tomlHtml: hl(S.brustToml, 'bash'),
    keyFiles: T.keyFiles,
  }
}
export async function firstRouteLoader() {
  return {
    ...chrome('/docs/first-route', 'Your first route · brust'),
    nativeHtml: hl(S.firstNative, 'tsx'),
    registerHtml: hl(S.firstRegister, 'tsx'),
    loaderHtml: hl(S.firstLoader, 'tsx'),
    runHtml: hl(S.firstRun, 'bash'),
  }
}
export async function commandsLoader() {
  return {
    ...chrome('/docs/commands', 'Dev & build · brust'),
    devHtml: hl(S.cmdDev, 'bash'),
    buildHtml: hl(S.cmdBuild, 'bash'),
    startHtml: hl(S.cmdStart, 'bash'),
  }
}

// ── Core concepts ──────────────────────────────────────────────────────────────
export async function routingLoader() {
  return {
    ...chrome('/docs/routing', 'Routing · brust'),
    defineHtml: hl(S.defineRoutes, 'tsx'),
    outletHtml: hl(S.outlet, 'tsx'),
    paramsHtml: hl(S.params, 'tsx'),
    loadersHtml: hl(S.loaders, 'tsx'),
    middlewareHtml: hl(S.middleware, 'tsx'),
    navHtml: hl(S.navigation, 'tsx'),
    routeFields: T.routeFields,
    routeStreaming: T.routeStreaming,
  }
}
export async function renderingLoader() {
  return {
    ...chrome('/docs/rendering', 'Rendering · brust'),
    streamingHtml: hl(S.streaming, 'tsx'),
    modesHtml: hl(S.modes, 'tsx'),
    islandHtml: hl(S.island, 'tsx'),
    islandUseHtml: hl(S.islandUse, 'tsx'),
    isrHtml: hl(S.isr, 'tsx'),
    isrInvalidateHtml: hl(S.isrInvalidate, 'tsx'),
    toggleHtml: hl(toggleSource, 'tsx'),
    modeCompare: T.modeCompare,
  }
}
export async function nativeInteractivityLoader() {
  return {
    ...chrome('/docs/native-interactivity', 'Native interactivity · brust'),
    directivesHtml: hl(S.directives, 'tsx'),
    counterHtml: hl(counterSource, 'tsx'),
    clockHtml: hl(clockSource, 'tsx'),
    chunksHtml: hl(S.chunks, 'tsx'),
    directiveRef: T.directiveRef,
    ctxMembers: T.ctxMembers,
  }
}
export async function storeLoader() {
  return {
    ...chrome('/docs/store', 'State — the store · brust'),
    signalsHtml: hl(S.signals, 'tsx'),
    defineHtml: hl(S.defineStore, 'tsx'),
    singletonHtml: hl(S.singleton, 'tsx'),
    useStoreHtml: hl(S.useStore, 'tsx'),
    counterHtml: hl(counterSource, 'tsx'),
    storePrimitives: T.storePrimitives,
  }
}
export async function actionsLoader() {
  return {
    ...chrome('/docs/actions', 'Actions & API · brust'),
    defineHtml: hl(S.defineActions, 'tsx'),
    clientHtml: hl(S.client, 'tsx'),
    validationHtml: hl(S.validation, 'tsx'),
    sseHtml: hl(S.sse, 'tsx'),
    wsHtml: hl(S.websocket, 'tsx'),
    playgroundHtml: hl(playgroundSource, 'tsx'),
  }
}
export async function stylingLoader() {
  return {
    ...chrome('/docs/styling', 'Styling · brust'),
    tailwindHtml: hl(S.tailwind, 'css'),
    classHtml: hl(S.classUse, 'tsx'),
    cssModuleHtml: hl(S.cssModule, 'css'),
    cssModuleUseHtml: hl(S.cssModuleUse, 'tsx'),
  }
}

// ── Platform ───────────────────────────────────────────────────────────────────
export async function agentsLoader() {
  return {
    ...chrome('/docs/agents', 'Agents · MCP · brust'),
    bootHtml: hl(S.mcpBoot, 'tsx'),
    toolsHtml: hl(S.mcpTools, 'json'),
    resourcesHtml: hl(S.mcpResources, 'json'),
  }
}
export async function cliLoader() {
  return {
    ...chrome('/docs/cli', 'CLI · brust'),
    devHtml: hl(S.cliDev, 'bash'),
    buildHtml: hl(S.cliBuild, 'bash'),
    newHtml: hl(S.cliNew, 'bash'),
    cliCommands: T.cliCommands,
  }
}
export async function deploymentLoader() {
  return {
    ...chrome('/docs/deployment', 'Deployment · brust'),
    dockerHtml: hl(S.dockerfile, 'bash'),
    configHtml: hl(S.deployConfig, 'bash'),
    healthHtml: hl(S.health, 'bash'),
    deployTargets: T.deployTargets,
  }
}

// Re-export NAV so the actions module (docs-as-data / MCP) can serve it.
export { NAV }
