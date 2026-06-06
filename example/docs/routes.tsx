import { defineRoutes } from 'brustjs/routes'
import Layout from './components/Layout'
import {
  actionsLoader,
  agentsLoader,
  cliLoader,
  commandsLoader,
  deploymentLoader,
  firstRouteLoader,
  homeLoader,
  installationLoader,
  introductionLoader,
  nativeInteractivityLoader,
  projectStructureLoader,
  renderingLoader,
  routingLoader,
  storeLoader,
  stylingLoader,
} from './lib/loaders'
import Actions from './pages/Actions'
import Agents from './pages/Agents'
import Cli from './pages/Cli'
import Commands from './pages/Commands'
import Deployment from './pages/Deployment'
import FirstRoute from './pages/FirstRoute'
import Home from './pages/Home'
import Installation from './pages/Installation'
import Introduction from './pages/Introduction'
import NativeInteractivity from './pages/NativeInteractivity'
import ProjectStructure from './pages/ProjectStructure'
import Rendering from './pages/Rendering'
import Routing from './pages/Routing'
import Store from './pages/Store'
import Styling from './pages/Styling'

// Every route is `native: true` — the whole site renders in Rust (zero React on
// the server) save for two React islands (⌘K palette, mobile drawer). Home is a
// STANDALONE route (full-width, owns its own chrome). Every /docs/* route nests
// under Layout (topbar + grouped sidebar + TOC rail + footer + pager), rendering
// into Layout's <Outlet/>. Each leaf loader returns the chrome fields Layout
// destructures plus the page's server-highlighted samples.
export const routes = defineRoutes([
  { path: '/', Component: Home, native: true, loader: homeLoader },
  {
    Component: Layout,
    native: true,
    children: [
      {
        path: '/docs/introduction',
        Component: Introduction,
        native: true,
        loader: introductionLoader,
      },
      {
        path: '/docs/installation',
        Component: Installation,
        native: true,
        loader: installationLoader,
      },
      {
        path: '/docs/project-structure',
        Component: ProjectStructure,
        native: true,
        loader: projectStructureLoader,
      },
      { path: '/docs/first-route', Component: FirstRoute, native: true, loader: firstRouteLoader },
      { path: '/docs/commands', Component: Commands, native: true, loader: commandsLoader },
      { path: '/docs/routing', Component: Routing, native: true, loader: routingLoader },
      { path: '/docs/rendering', Component: Rendering, native: true, loader: renderingLoader },
      {
        path: '/docs/native-interactivity',
        Component: NativeInteractivity,
        native: true,
        loader: nativeInteractivityLoader,
      },
      { path: '/docs/store', Component: Store, native: true, loader: storeLoader },
      { path: '/docs/actions', Component: Actions, native: true, loader: actionsLoader },
      { path: '/docs/styling', Component: Styling, native: true, loader: stylingLoader },
      { path: '/docs/agents', Component: Agents, native: true, loader: agentsLoader },
      { path: '/docs/cli', Component: Cli, native: true, loader: cliLoader },
      { path: '/docs/deployment', Component: Deployment, native: true, loader: deploymentLoader },
    ],
  },
])
