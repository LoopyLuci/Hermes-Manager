import { useState } from 'react'
import { StatusRibbon } from './components/StatusRibbon'
import { OverviewPage } from './features/overview/OverviewPage'
import { FirstRunWizard, useHermesWizard } from './features/setup/FirstRunWizard'
import { LogsPage } from './features/logs/LogsPage'
import { GatewayPage } from './features/gateway/GatewayPage'
import { SessionsPage } from './features/sessions/SessionsPage'
import { ChatPage } from './features/chat/ChatPage'
import { ConfigPage } from './features/config/ConfigPage'
import { UpdatesPage } from './features/updates/UpdatesPage'
import { BackupsPage } from './features/backups/BackupsPage'
import { ToolsPage } from './features/tools/ToolsPage'
import { useBridgeHealth } from './hooks/use-bridge-health'
import { useSourceStatus } from './hooks/use-source-status'

const NAVIGATION = [
  { id: 'overview', label: 'Overview', ready: true },
  { id: 'logs', label: 'Logs', ready: true },
  { id: 'gateway', label: 'Gateway', ready: true },
  { id: 'sessions', label: 'Sessions', ready: true },
  { id: 'chat', label: 'Chat', ready: true },
  { id: 'updates', label: 'Updates', ready: true, target: 'M6' },
  { id: 'backups', label: 'Backups', ready: true, target: 'M6' },
  { id: 'config', label: 'Config', ready: true, target: 'M5' },
  { id: 'tools', label: 'Tools', ready: true },
] as const

export function App(): React.JSX.Element {
  const { health, error, live, uptimeS, refresh } = useBridgeHealth()
  const { sources } = useSourceStatus()
  const wizard = useHermesWizard()
  const [page, setPage] = useState<string>('overview')

  const renderPage = (): React.JSX.Element => {
    switch (page) {
      case 'logs':
        return <LogsPage />
      case 'gateway':
        return <GatewayPage />
      case 'sessions':
        return <SessionsPage />
      case 'chat':
        return <ChatPage />
      case 'config':
        return <ConfigPage />
      case 'updates':
        return <UpdatesPage />
      case 'backups':
        return <BackupsPage />
      case 'tools':
        return <ToolsPage />
      default:
        return (
          <OverviewPage
            health={health}
            sources={sources}
            error={error}
            uptimeS={uptimeS}
            refresh={refresh}
          />
        )
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">H</span>
          <span className="brand-name">Hermes Manager</span>
        </div>
        <nav className="nav" aria-label="Sections">
          {NAVIGATION.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item${page === item.id ? ' nav-item-active' : ''}${item.ready ? '' : ' nav-item-pending'}`}
              aria-current={page === item.id ? 'page' : undefined}
              data-testid={`nav-${item.id}`}
              onClick={() => item.ready && setPage(item.id)}
              disabled={!item.ready}
            >
              {item.label}
              {!item.ready ? (
                <span className="nav-tag">{(item as { target?: string }).target}</span>
              ) : null}
            </button>
          ))}
        </nav>
      </aside>

      <div className="content">
        {renderPage()}
        <StatusRibbon health={health} live={live} error={error} />
      </div>

      {wizard.show ? (
        <FirstRunWizard
          detected={wizard.detected}
          busy={wizard.busy}
          error={wizard.error}
          onUseDetected={wizard.useDetected}
          onPick={wizard.pick}
          onDismiss={wizard.dismiss}
        />
      ) : null}
    </div>
  )
}
