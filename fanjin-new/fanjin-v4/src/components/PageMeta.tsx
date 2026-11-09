import { useEffect } from "react";

interface PageMetaProps {
  title: string;
  description?: string;
}

export function PageMeta({ title, description }: PageMetaProps) {
  useEffect(() => {
    document.title = title;
    if (description) {
      let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
      if (!meta) {
        meta = document.createElement("meta");
        meta.name = "description";
        document.head.appendChild(meta);
      }
      meta.content = description;
    }
  }, [title, description]);

  return null;
}
