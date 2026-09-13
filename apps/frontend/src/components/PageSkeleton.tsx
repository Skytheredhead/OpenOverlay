type SkeletonVariant = "games" | "media" | "editor";

function Line({ short = false }: { short?: boolean }) {
  return <span className={`skeleton skeleton-line${short ? " skeleton-line-short" : ""}`} />;
}

function Fields() {
  return (
    <div className="skeleton-fields">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="skeleton-field" key={index}>
          <Line short />
          <span className="skeleton skeleton-input" />
        </div>
      ))}
    </div>
  );
}

export function SidebarSkeleton() {
  return (
    <div className="sidebar-loading" role="status" aria-label="Loading games" aria-busy="true">
      <div aria-hidden="true">
        <Line />
        <Line short />
      </div>
    </div>
  );
}

export function TeamListSkeleton() {
  return (
    <div role="status" aria-label="Loading teams" aria-busy="true">
      <div className="skeleton-team-list" aria-hidden="true">
        {Array.from({ length: 3 }, (_, index) => (
          <div className="skeleton-team-row" key={index}>
            <span className="skeleton skeleton-avatar" />
            <div>
              <Line />
              <Line short />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TeamEditorSkeleton() {
  return (
    <div className="skeleton-team-editor" aria-hidden="true">
      <span className="skeleton skeleton-card-title" />
      <Fields />
    </div>
  );
}

export function PageSkeleton({ variant, title, contentOnly = false }: { variant: SkeletonVariant; title?: string; contentOnly?: boolean }) {
  return (
    <div className={`page-skeleton page-skeleton-${variant}`}>
      {!contentOnly && <div className="page-title">{title ? <h1>{title}</h1> : <span className="skeleton skeleton-title" aria-hidden="true" />}</div>}
      <div role="status" aria-label={`Loading ${variant === "editor" ? "game" : variant}`} aria-busy="true">
        <div aria-hidden="true">
          {variant === "games" && (
            <div className="preset-grid game-card-grid skeleton-grid">
              {Array.from({ length: 4 }, (_, index) => (
                <div className="skeleton-game-card" key={index}>
                  <Line short />
                  <span className="skeleton skeleton-card-title" />
                  <div className="skeleton-actions">
                    <span className="skeleton skeleton-button" />
                    <span className="skeleton skeleton-button" />
                  </div>
                </div>
              ))}
            </div>
          )}
          {variant === "media" && (
            <>
              <div className="media-grid skeleton-media-grid">
                {Array.from({ length: 6 }, (_, index) => (
                  <div className="skeleton-media-card" key={index}>
                    <span className="skeleton skeleton-thumbnail" />
                    <Line />
                    <Line short />
                  </div>
                ))}
              </div>
            </>
          )}
          {variant === "editor" && (
            <>
              <div className="skeleton-actions skeleton-toolbar">
                <span className="skeleton skeleton-button" />
                <span className="skeleton skeleton-button" />
                <span className="skeleton skeleton-button" />
              </div>
              <div className="skeleton-editor-layout">
                <div className="skeleton-editor-controls">
                  <div className="skeleton-actions">
                    <Line short />
                    <Line short />
                    <Line short />
                  </div>
                  <span className="skeleton skeleton-score" />
                  <Fields />
                </div>
                <div className="skeleton-preview-column">
                  <span className="skeleton skeleton-preview" />
                  <Line short />
                  <div className="skeleton-fields">
                    <span className="skeleton skeleton-overlay" />
                    <span className="skeleton skeleton-overlay" />
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
