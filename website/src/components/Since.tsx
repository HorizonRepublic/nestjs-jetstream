import React from 'react';

interface SinceProps {
  version: string;
}

export default function Since({ version }: SinceProps): React.ReactElement {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        fontSize: '0.8rem',
        fontWeight: 600,
        borderRadius: '4px',
        backgroundColor: 'var(--ifm-color-primary-lightest)',
        color: 'var(--ifm-color-primary-darkest)',
        marginBottom: '1rem',
      }}
    >
      Since v{version}
    </span>
  );
}
