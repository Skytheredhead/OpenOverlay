import { Activity, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useLocation, type Location } from "react-router-dom";

// Keep the most recently visited pages for this signed-in workspace. Unvisited
// routes never mount, and evicted pages release their state and detached DOM.
const PAGE_CACHE_LIMIT = 8;

export function CachedPages({ children }: { children: (location: Location) => ReactNode }) {
  const location = useLocation();
  const hostRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<Location[]>([location]);
  if (pages.at(-1) !== location) {
    setPages([...pages.filter((page) => page.pathname !== location.pathname), location].slice(-PAGE_CACHE_LIMIT));
  }

  return (
    <>
      <div className="workspace-pages" ref={hostRef} />
      {pages.map((page) => (
        <CachedPage key={page.pathname} active={page.pathname === location.pathname} hostRef={hostRef}>
          {children(page)}
        </CachedPage>
      ))}
    </>
  );
}

function CachedPage({ active, hostRef, children }: { active: boolean; hostRef: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const [container] = useState(() => {
    const element = document.createElement("div");
    element.className = "workspace-page";
    return element;
  });
  useLayoutEffect(() => {
    if (active) hostRef.current?.appendChild(container);
    return () => container.remove();
  }, [active, container, hostRef]);

  // Activity retains component state while cleaning up hidden-page effects.
  // Detaching the container also keeps inactive IDs, forms and landmarks out of
  // the document, accessibility tree and browser find-in-page results.
  return createPortal(<Activity mode={active ? "visible" : "hidden"}>{children}</Activity>, container);
}
