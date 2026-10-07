"use client";

import dynamic from "next/dynamic";

const App = dynamic(() => import("../../src/App"), {
  ssr: false,
  loading: () => (
    <main className="app-loading" aria-label="Loading Watchtower" />
  ),
});

export default function AppClient() {
  return <App />;
}
