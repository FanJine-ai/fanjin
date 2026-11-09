import type { HTMLAttributes } from "react";

export type StoryboardData = Record<string, unknown>;

export function StoryboardPreview(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} />;
}
