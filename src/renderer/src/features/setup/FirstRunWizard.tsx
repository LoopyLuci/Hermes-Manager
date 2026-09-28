import { useEffect, useState } from 'react'

interface WizardProps {
  detected: string | null
  busy: boolean
  error: string | null
  onUseDetected: () => void
  onPick: () => void
  onDismiss: () => void
}

export function FirstRunWizard({
  detected,
  busy,
  error,
  onUseDetected,
  onPick,
  onDismiss
}: WizardProps): React.JSX.Element {
  return (
    <div className="wizard-backdrop" role="dialog" aria-modal="true" aria-label="Locate Hermes">
      <div className="wizard">
        <h1>Locate your Hermes install</h1>
        <p className="wizard-copy">
          Hermes Manager reads logs, state and configuration from a Hermes home directory. Pick the folder that
          contains <code>hermes-agent</code>.
        </p>

        {detected ? (
          <div className="wizard-detected">
            <span className="card-label">Detected</span>
            <code>{detected}</code>
            <button type="button" className="button button-primary" onClick={onUseDetected} disabled={busy}>
              {busy ? 'Starting…' : 'Use this location'}
            </button>
          </div>
        ) : (
          <div className="wizard-detected">
            <span className="card-label">Auto-detection</span>
            <p className="wizard-copy">No Hermes install was found in the usual places.</p>
          </div>
        )}

        <button type="button" className="button" onClick={onPick} disabled={busy}>
          Browse…
        </button>

        {error ? <p className="wizard-error">{error}</p> : null}

        <button type="button" className="button button-ghost" onClick={onDismiss}>
          Continue without connecting
        </button>
      </div>
    </div>
  )
}

export function useHermesWizard(): {
  show: boolean
  detected: string | null
  busy: boolean
  error: string | null
  useDetected: () => void
  pick: () => void
  dismiss: () => void
} {
  const [show, setShow] = useState(false)
  const [detected, setDetected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = async (): Promise<void> => {
    const found = await window.hermes?.detectHermesHome?.()
    setDetected(found)
    setShow(true)
  }

  useEffect(() => {
    if (!window.hermes?.onHermesHomeMissing) return
    return window.hermes.onHermesHomeMissing(() => {
      void open()
    })
  }, [])

  const apply = async (home: string | null): Promise<void> => {
    if (!home) {
      setError('That folder does not contain a hermes-agent checkout.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await window.hermes?.writeSettings?.({ hermesHome: home })
      await window.hermes?.restartBridge?.()
      setShow(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return {
    show,
    detected,
    busy,
    error,
    useDetected: () => void apply(detected),
    pick: () => void window.hermes?.pickHermesHome?.().then((home) => apply(home)),
    dismiss: () => setShow(false)
  }
}
