import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { ImagePlus, LoaderCircle, MessageSquareWarning, Send, Trash2 } from "lucide-react";
import { submitFeedback, type FeedbackScreenshotPayload } from "../../api/feedback";
import { useAuthStore } from "../../stores/authStore";
import { useToast } from "../../ui/console/feedback";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { captureFeedbackPageContext, type FeedbackPageContext } from "./feedbackPageContext";
import "./FeedbackWidget.css";

const MAX_FILES = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const MIN_DESCRIPTION_LENGTH = 2;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

type SelectedImage = FeedbackScreenshotPayload & { key: string; previewUrl: string };

function captureCurrentPageContext() {
  const pageTitleHint = document.querySelector<HTMLElement>("[data-feedback-page-title]")
    ?.dataset.feedbackPageTitle || "";
  return captureFeedbackPageContext(window.location, document.title, pageTitleHint);
}

function readImage(file: File): Promise<SelectedImage> {
  return new Promise((resolve, reject) => {
    if (!IMAGE_TYPES.has(file.type)) return reject(new Error("仅支持 JPG、PNG、WebP 或 GIF 图片"));
    if (file.size > MAX_BYTES) return reject(new Error("每张截图不能超过 5MB"));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("截图读取失败"));
    reader.onload = () => resolve({
      key: `${file.name}-${file.size}-${file.lastModified}`,
      fileName: file.name,
      mimeType: file.type,
      dataUrl: String(reader.result || ""),
      previewUrl: String(reader.result || ""),
    });
    reader.readAsDataURL(file);
  });
}

export default function FeedbackWidget() {
  const user = useAuthStore((state) => state.user);
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const pageContextRef = useRef<FeedbackPageContext | null>(null);
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [images, setImages] = useState<SelectedImage[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [consoleSlot, setConsoleSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // App owns one feedback dialog outside the router. Dock its trigger into
    // the console header when that shell mounts; canvas keeps the floating entry.
    const syncSlot = () => setConsoleSlot(document.getElementById("console-feedback-slot"));
    syncSlot();
    const observer = new MutationObserver(syncSlot);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);


  const addFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) return;
    if (images.length + imageFiles.length > MAX_FILES) {
      toast({ title: "最多上传 3 张截图", tone: "warning" });
      return;
    }
    try {
      const next = await Promise.all(imageFiles.map(readImage));
      setImages((current) => [...current, ...next.filter((item) => !current.some((old) => old.key === item.key))].slice(0, MAX_FILES));
    } catch (caught) {
      toast({ title: caught instanceof Error ? caught.message : "截图添加失败", tone: "danger" });
    }
  }, [images.length, toast]);

  if (!user) return null;

  const reset = () => {
    setDescription("");
    setImages([]);
    setDragging(false);
    pageContextRef.current = null;
    if (inputRef.current) inputRef.current.value = "";
  };

  const onOpenChange = (next: boolean) => {
    if (submitting) return;
    if (next) pageContextRef.current = captureCurrentPageContext();
    setOpen(next);
    if (!next) reset();
  };

  const onFiles = (event: ChangeEvent<HTMLInputElement>) => {
    void addFiles(Array.from(event.target.files || []));
    event.target.value = "";
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files || []);
    if (files.some((file) => file.type.startsWith("image/"))) void addFiles(files);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void addFiles(Array.from(event.dataTransfer.files || []));
  };

  const submit = async () => {
    const value = description.trim();
    if (value.length < MIN_DESCRIPTION_LENGTH) {
      toast({ title: `请至少填写 ${MIN_DESCRIPTION_LENGTH} 个字的问题描述`, tone: "warning" });
      return;
    }
    setSubmitting(true);
    try {
      const pageContext = pageContextRef.current
        || captureCurrentPageContext();
      const result = await submitFeedback({
        description: value,
        pageTitle: pageContext.pageTitle,
        pageUrl: pageContext.pageUrl,
        screenshots: images.map(({ fileName, mimeType, dataUrl }) => ({ fileName, mimeType, dataUrl })),
      });
      toast({ title: "反馈已提交", message: `反馈编号：${result.feedbackNo}`, tone: "success" });
      setOpen(false);
      reset();
    } catch (caught) {
      toast({ title: "提交失败", message: caught instanceof Error ? caught.message : "请稍后重试", tone: "danger" });
    } finally {
      setSubmitting(false);
    }
  };

  const descriptionLength = description.trim().length;
  const descriptionTooShort = descriptionLength < MIN_DESCRIPTION_LENGTH;

  const trigger = (
    <button
        type="button"
        aria-label="提交问题反馈"
        title="提交问题反馈"
        onClick={() => onOpenChange(true)}
        className={consoleSlot ? "feedbackFab feedbackFab--docked" : "feedbackFab"}
      >
        <span className="feedbackFabIcon">
          <MessageSquareWarning aria-hidden="true" />
        </span>
        <span className="feedbackFabLabel">问题反馈</span>
      </button>
  );

  return (
    <>
      {consoleSlot ? createPortal(trigger, consoleSlot) : trigger}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>提交问题反馈</DialogTitle>
            <DialogDescription>请描述遇到的问题，可附上当前页面截图。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <label className="block text-sm font-medium text-neutral-800" htmlFor="feedback-description">问题描述</label>
            <textarea
              id="feedback-description"
              value={description}
              maxLength={4000}
              rows={6}
              autoFocus
              aria-describedby="feedback-description-help"
              aria-invalid={description.length > 0 && descriptionTooShort}
              onPaste={onPaste}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="请说明操作步骤、预期结果和实际发生的问题"
              className="w-full resize-y rounded-lg border border-neutral-300 bg-white px-3.5 py-3 text-sm text-neutral-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100 aria-invalid:border-rose-400 aria-invalid:focus:border-rose-500 aria-invalid:focus:ring-rose-100"
            />
            <div id="feedback-description-help" className="flex min-h-5 items-center justify-between gap-3 text-xs">
              <span className={description.length > 0 && descriptionTooShort ? "text-rose-600" : "text-neutral-500"}>
                {description.length > 0 && descriptionTooShort
                  ? `至少输入 ${MIN_DESCRIPTION_LENGTH} 个字，还需 ${MIN_DESCRIPTION_LENGTH - descriptionLength} 个字`
                  : `至少输入 ${MIN_DESCRIPTION_LENGTH} 个字`}
              </span>
              <span className="shrink-0 text-neutral-500">{description.length}/4000</span>
            </div>
            <div
              onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`rounded-md border border-dashed p-4 ${dragging ? "border-blue-500 bg-blue-50" : "border-neutral-300 bg-neutral-50"}`}
            >
              <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden onChange={onFiles} />
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm text-neutral-600">截图 {images.length}/{MAX_FILES}，单张不超过 5MB</div>
                <Button type="button" variant="outline" size="sm" disabled={images.length >= MAX_FILES} onClick={() => inputRef.current?.click()}>
                  <ImagePlus className="h-4 w-4" /> 添加截图
                </Button>
              </div>
              {images.length > 0 && (
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {images.map((image) => (
                    <div key={image.key} className="relative aspect-video overflow-hidden rounded-md border bg-white">
                      <img src={image.previewUrl} alt={image.fileName} className="h-full w-full object-cover" />
                      <button type="button" aria-label={`删除 ${image.fileName}`} title="删除截图" onClick={() => setImages((current) => current.filter((item) => item.key !== image.key))} className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-md bg-black/70 text-white hover:bg-black">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="lg" className="min-w-20 px-4" disabled={submitting} onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="button" size="lg" className="min-w-28 px-4" disabled={submitting || descriptionTooShort} onClick={() => void submit()}>
              {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {submitting ? "提交中" : "提交反馈"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
