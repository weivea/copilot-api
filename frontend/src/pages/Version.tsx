import { ReleaseVersion } from "../components/ReleaseVersion"

export default function Version() {
  return (
    <div>
      <h2>Version</h2>
      <div className="card" style={{ maxWidth: 420 }}>
        <div>Copilot API</div>
        <ReleaseVersion />
      </div>
    </div>
  )
}
