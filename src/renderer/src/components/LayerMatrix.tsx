import type { LayerStatus, SourceLayer } from '@shared/protocol'

const LAYER_LABELS: Record<SourceLayer, string> = {
  rest: 'hermes serve API',
  files: 'Log & state files',
  db: 'state.db',
  cli: 'hermes CLI',
  deep: 'In-process imports'
}

const LAYER_ORDER: SourceLayer[] = ['rest', 'files', 'db', 'cli', 'deep']

function formatLatency(latency: number | null): string {
  if (latency === null) return '-'
  return `${latency.toFixed(0)} ms`
}

export function LayerMatrix({ layers }: { layers: Record<SourceLayer, LayerStatus> }): React.JSX.Element {
  return (
    <table className="matrix" data-testid="layer-matrix">
      <thead>
        <tr>
          <th>Layer</th>
          <th>State</th>
          <th>Detail</th>
          <th>Origin</th>
          <th className="numeric">Probe</th>
        </tr>
      </thead>
      <tbody>
        {LAYER_ORDER.map((layer) => {
          const status = layers[layer]
          if (!status) return null
          return (
            <tr key={layer} data-layer={layer}>
              <td className="layer-name">{LAYER_LABELS[layer]}</td>
              <td>
                <span className={`badge badge-${status.state}`}>{status.state}</span>
              </td>
              <td className="detail">{status.detail}</td>
              <td className="origin" title={status.origin}>
                {status.origin}
              </td>
              <td className="numeric">{formatLatency(status.latency_ms)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
