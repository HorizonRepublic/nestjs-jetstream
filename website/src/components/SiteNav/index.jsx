import React, { useEffect, useState } from 'react';
import Link from '@docusaurus/Link';
import { useLocation } from '@docusaurus/router';
import NavbarMobileSidebarToggle from '@theme/Navbar/MobileSidebar/Toggle';
import NavbarColorModeToggle from '@theme/Navbar/ColorModeToggle';
import rootPkg from '../../../../package.json';
import styles from './styles.module.css';

const NPM_PACKAGE = '@horizon-republic/nestjs-jetstream';
const FALLBACK_VERSION = rootPkg.version;
const GITHUB_HREF = 'https://github.com/HorizonRepublic/nestjs-jetstream';
const NPM_HREF = 'https://www.npmjs.com/package/@horizon-republic/nestjs-jetstream';
const CHANGELOG_HREF = 'https://github.com/HorizonRepublic/nestjs-jetstream/releases';
const DOCS_PATH = '/docs/';
const API_PATH = '/docs/reference/api';

const useLiveVersion = (initial) => {
  const [version, setVersion] = useState(initial);

  useEffect(() => {
    let alive = true;
    const url = `https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE)}/latest`;

    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (alive && data?.version) setVersion(data.version);
      })
      .catch(() => { /* keep fallback */ });

    return () => { alive = false; };
  }, []);

  return version;
};

const BrandMark = () => (
  <svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <path d="M7 11 H21" stroke="currentColor" strokeWidth="2.6" strokeLinecap="square" />
    <path d="M4 16 H21" stroke="currentColor" strokeWidth="2.6" strokeLinecap="square" />
    <path d="M7 21 H17" stroke="currentColor" strokeWidth="2.6" strokeLinecap="square" />
    <rect x="20.7" y="17.4" width="7.3" height="7.3" fill="var(--jt-state-deliver)" />
  </svg>
);

const triggerCommandPalette = () => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('jt:open-command-palette'));
};

export default function SiteNav() {
  const version = useLiveVersion(FALLBACK_VERSION);
  const versionLabel = `v${version}`;
  const location = useLocation();
  const pathname = location?.pathname ?? '';

  const isApi = /\/docs\/reference\/api/.test(pathname);
  const isDocs = /\/docs(?!\/reference\/api)/.test(pathname);

  return (
    <div className={styles.inner}>
      <div className={styles.mobileToggle}>
        <NavbarMobileSidebarToggle />
      </div>
      <Link to="/" className={styles.brand}>
        <span className={styles.brandMark}><BrandMark /></span>
        <span className={styles.brandScope}>@horizon-republic/nestjs-jetstream</span>
      </Link>
      <span className={styles.version}>{versionLabel}</span>
      <div className={styles.links}>
        <Link className={`${styles.link} ${isDocs ? styles.linkActive : ''}`} to={DOCS_PATH}>Docs</Link>
        <Link className={`${styles.link} ${isApi ? styles.linkActive : ''}`} to={API_PATH}>API Reference</Link>
        <a className={styles.link} href={CHANGELOG_HREF} target="_blank" rel="noopener noreferrer">Changelog</a>
      </div>
      <div className={styles.spacer} />
      <button
        type="button"
        className={styles.search}
        onClick={triggerCommandPalette}
        aria-label="Open command palette"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" />
        </svg>
        <span className={styles.searchText}>Search docs…</span>
        <span className={styles.kbd}>⌘K</span>
      </button>
      <div className={styles.actions}>
        <NavbarColorModeToggle className={styles.colorMode} />
        <a className={styles.iconBtn} href={NPM_HREF} target="_blank" rel="noopener noreferrer" aria-label="npm package">
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M0 0v16h16V0H0zm13 13h-2V5H8v8H3V3h10v10z" />
          </svg>
          <span>npm</span>
        </a>
        <a className={styles.iconBtn} href={GITHUB_HREF} target="_blank" rel="noopener noreferrer" aria-label="GitHub repository">
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.34c-2.23.48-2.7-1.07-2.7-1.07-.37-.93-.9-1.18-.9-1.18-.73-.5.06-.49.06-.49.81.06 1.24.83 1.24.83.72 1.23 1.88.88 2.34.67.07-.52.28-.88.5-1.08-1.78-.2-3.65-.89-3.65-3.96 0-.88.31-1.6.83-2.16-.08-.2-.36-1.02.08-2.13 0 0 .67-.21 2.2.83a7.7 7.7 0 0 1 4 0c1.53-1.04 2.2-.83 2.2-.83.44 1.11.16 1.93.08 2.13.52.56.83 1.28.83 2.16 0 3.08-1.88 3.76-3.66 3.96.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0z" />
          </svg>
          <span>GitHub</span>
        </a>
      </div>
    </div>
  );
}
