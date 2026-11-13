import { version } from "../../../package.json"

export function ReleaseVersion() {
  return <div className="release-version">Release v{version}</div>
}
