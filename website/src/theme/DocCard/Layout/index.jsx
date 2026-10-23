import React from 'react';
import Layout from '@theme-original/DocCard/Layout';

/* Index cards lead with a small mark in the section's tone instead of an emoji. */
export default function DocCardLayoutWrapper(props) {
  return <Layout {...props} icon={<span className="jt-card-mark" aria-hidden="true" />} />;
}
