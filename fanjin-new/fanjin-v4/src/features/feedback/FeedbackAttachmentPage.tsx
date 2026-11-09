import { useEffect, useState } from "react";
import { ArrowLeft, Download, LoaderCircle } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { fetchFeedbackAttachment } from "../../api/feedback";

export default function FeedbackAttachmentPage() {
  const { id = "" } = useParams();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    setUrl("");
    setError("");
    void fetchFeedbackAttachment(id, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((caught) => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "截图加载失败"); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id]);

  return (
    <main className="min-h-screen bg-neutral-100 p-4 sm:p-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <Link to="/workbench/create" className="inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm text-neutral-700 hover:bg-white"><ArrowLeft className="h-4 w-4" />返回平台</Link>
          {url && <a href={url} download={`feedback-${id}`} className="inline-flex h-10 items-center gap-2 rounded-md bg-neutral-900 px-4 text-sm text-white hover:bg-neutral-800"><Download className="h-4 w-4" />下载</a>}
        </div>
        <div className="flex min-h-[70vh] items-center justify-center overflow-hidden rounded-md border bg-white p-3">
          {!url && !error && <div className="flex items-center gap-2 text-sm text-neutral-500"><LoaderCircle className="h-5 w-5 animate-spin" />正在加载截图</div>}
          {error && <div className="text-sm text-red-600">{error}</div>}
          {url && <img src={url} alt="用户反馈截图" className="max-h-[82vh] max-w-full object-contain" />}
        </div>
      </div>
    </main>
  );
}
