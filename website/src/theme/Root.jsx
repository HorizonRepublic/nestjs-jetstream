
import React from "react";
import CommandPalette from "@site/src/components/CommandPalette";

export default function Root({ children }) {
  return (
    <>
      {children}
      <CommandPalette />
    </>
  );
}
