import React from 'react';

interface SinceProps {
  version: string;
}

/**
 * Mono-uppercase badge marking when an API was introduced.
 * Reads as a metadata tag, not a button — so it stays out of the
 * way of running prose and the accent button styling.
 */
export default function Since({ version }: SinceProps): React.ReactElement {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '3px 9px',
        fontFamily: 'var(--jt-font-mono)',
        fontSize: '11px',
        fontWeight: 500,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        borderRadius: '4px',
        backgroundColor: 'var(--jt-accent-soft)',
        color: 'var(--jt-accent)',
        border: '1px solid var(--jt-accent-line)',
        marginBottom: '1rem',
        verticalAlign: 'baseline',
      }}
    >
      <span
        style={{
          width: '5px',
          height: '5px',
          borderRadius: '999px',
          backgroundColor: 'var(--jt-accent)',
          boxShadow: '0 0 0 3px var(--jt-accent-soft)',
        }}
        aria-hidden="true"
      />
      Since v{version}
    </span>
  );
}
