import { useEffect } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { Home } from "./pages/Home";
import { Dashboard } from "./pages/Dashboard";
import { Docs } from "./pages/Docs";
import { Pit } from "./pages/Pit";

/** Scroll to top (or to hash target) on route change. */
function ScrollManager() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      // getElementById: querySelector throws on ids starting with a digit (M-05)
      const el = document.getElementById(hash.slice(1));
      if (el) { el.scrollIntoView(); return; }
    }
    window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

export default function App() {
  return (
    <>
      <ScrollManager />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/app" element={<Dashboard />} />
        <Route path="/pit" element={<Pit />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/docs/:slug" element={<Docs />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </>
  );
}
