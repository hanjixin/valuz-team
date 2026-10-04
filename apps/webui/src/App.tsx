import { WebPlatformProvider } from '@valuz/app/platform'
import { ErrorBoundary } from '@valuz/ui'
import { AppRouter } from './app/router'

// Root boundary: without it, any uncaught render/effect throw above the
// layout-level boundary (router root, layout hooks) unmounts the entire
// tree — a permanently white page that only a reload can recover. Degrade
// to the "Something went wrong" fallback with a Retry instead.
export const App = () => (
  <WebPlatformProvider>
    <ErrorBoundary>
      <AppRouter />
    </ErrorBoundary>
  </WebPlatformProvider>
)
