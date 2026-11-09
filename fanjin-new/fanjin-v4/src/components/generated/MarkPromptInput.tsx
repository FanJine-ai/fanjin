import type { TextareaHTMLAttributes } from "react";

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  className?: string;
};

export function MarkPromptInput({ className = "", ...props }: Props) {
  return <textarea className={className} {...props} />;
}
