import React, { useState, useEffect, useMemo, useRef } from "react";
import { useHistory } from "@docusaurus/router";
import useBaseUrl from "@docusaurus/useBaseUrl";
import styles from "./styles.module.css";

/**
 * Cmd/Ctrl+K command palette. Self-contained — listens for the shortcut at the
 * window level and renders a modal. Pass `items` as [{ section, kind, label, to }].
 * Wire to DocSearch later by replacing the static items prop.
 */
const DEFAULT_ITEMS = [
  { section: "Getting started", kind: "doc", label: "Quick Start", to: "/docs/getting-started/quick-start" },
  { section: "Getting started", kind: "doc", label: "Why JetStream?", to: "/docs/getting-started/why-jetstream" },
  { section: "Getting started", kind: "doc", label: "Migration from Core NATS", to: "/docs/guides/migration" },
  { section: "Patterns", kind: "doc", label: "Events", to: "/docs/patterns/events" },
  { section: "Patterns", kind: "doc", label: "RPC", to: "/docs/patterns/rpc" },
  { section: "Patterns", kind: "doc", label: "Broadcast", to: "/docs/patterns/broadcast" },
  { section: "Patterns", kind: "doc", label: "Ordered delivery", to: "/docs/patterns/ordered-events" },
  { section: "Production", kind: "doc", label: "Module config", to: "/docs/getting-started/module-configuration" },
  { section: "Production", kind: "doc", label: "Dead-letter queue", to: "/docs/guides/dead-letter-queue" },
  { section: "Production", kind: "doc", label: "Health checks", to: "/docs/guides/health-checks" },
  { section: "External", kind: "link", label: "GitHub repository", to: "https://github.com/HorizonRepublic/nestjs-jetstream" },
  { section: "External", kind: "link", label: "npm package", to: "https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream" },
];

export default function CommandPalette({ items = DEFAULT_ITEMS }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef(null);
  const history = useHistory();

  // global shortcut
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);

    window.addEventListener("keydown", onKey);
    window.addEventListener("jt:open-command-palette", onOpen);

    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("jt:open-command-palette", onOpen);
    };
  }, []);

  // focus input when opened
  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
    if (open) { setQuery(""); setActiveIdx(0); }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.label.toLowerCase().includes(q));
  }, [query, items]);

  // group by section
  const grouped = useMemo(() => {
    const out = {};
    filtered.forEach((it) => {
      (out[it.section] ||= []).push(it);
    });
    return out;
  }, [filtered]);

  const flat = filtered;

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && flat[activeIdx]) {
      e.preventDefault();
      go(flat[activeIdx]);
    }
  };

  const baseUrl = useBaseUrl("/");
  const baseUrlNoSlash = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

  const go = (item) => {
    setOpen(false);
    if (/^https?:\/\//i.test(item.to)) {
      window.open(item.to, "_blank", "noopener,noreferrer");
    } else {
      history.push(`${baseUrlNoSlash}${item.to}`);
    }
  };

  if (!open) return null;

  return (
    <div className={styles.backdrop} onClick={() => setOpen(false)}>
      <div className={styles.palette} onClick={(e) => e.stopPropagation()}>
        <div className={styles.head}>
          <svg className={styles.searchIcon} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="9" cy="9" r="6" />
            <path d="M14 14l3.5 3.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            className={styles.input}
            placeholder="Search docs, jump to a section…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
            onKeyDown={onKeyDown}
          />
          <span className={styles.closeKbd}>Esc</span>
        </div>

        <div className={styles.results}>
          {flat.length === 0 && <div className={styles.empty}>No results for &ldquo;{query}&rdquo;</div>}
          {(() => {
            let runningIdx = 0;

            return Object.entries(grouped).map(([section, list]) => (
              <div key={section}>
                <div className={styles.section}>{section}</div>
                {list.map((item) => {
                  const idx = runningIdx++;

                  return (
                    <div
                      key={item.label}
                      className={`${styles.item} ${idx === activeIdx ? styles.active : ""}`}
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => go(item)}
                    >
                      <span>{item.label}</span>
                      <span className={styles.itemKind}>{item.kind}</span>
                    </div>
                  );
                })}
              </div>
            ));
          })()}
        </div>

        <div className={styles.foot}>
          <span><kbd>↑↓</kbd>navigate</span>
          <span><kbd>↵</kbd>select</span>
          <span><kbd>esc</kbd>close</span>
        </div>
      </div>
    </div>
  );
}
