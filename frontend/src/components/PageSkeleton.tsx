export function PageSkeleton() {
  return (
    <div
      style={{
        padding: "2rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--muted, #888)",
        minHeight: "200px",
      }}
    >
      Loading…
    </div>
  )
}

export default PageSkeleton
