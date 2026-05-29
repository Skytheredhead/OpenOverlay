/// <reference types="vite/client" />

interface OpenOverlayBuildInfo {
  version: string | null;
  commit: string | null;
  commitShort: string | null;
  requiredApiVersion: string;
  requiredRealtimeVersion: string;
}

declare const __OPENOVERLAY_BUILD_INFO__: OpenOverlayBuildInfo;
