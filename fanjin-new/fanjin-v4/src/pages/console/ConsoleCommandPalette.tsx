import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { ArrowRight, Search, SearchX } from "lucide-react";
import { Dialog, Input } from "../../ui/console";
import type { ConsoleMenuSection } from "../../routes/consoleRegistry";
import "./ConsoleCommandPalette.css";

type ConsoleCommandPaletteProps = {
  open: boolean;
  sections: ConsoleMenuSection[];
  returnFocusRef?: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  onNavigate: (path: string) => void;
};

export function ConsoleCommandPalette({
  open,
  sections,
  returnFocusRef,
  onOpenChange,
  onNavigate,
}: ConsoleCommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const searchId = useId();
  const instructionsId = useId();
  const listboxId = useId();
  const optionIdPrefix = useId();

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  const results = useMemo(() => {
    const terms = query
      .trim()
      .toLocaleLowerCase("zh-CN")
      .split(/\s+/)
      .filter(Boolean);

    return sections
      .flatMap((section) => section.items.map((item) => ({ ...item, section: section.label })))
      .filter((item) => {
        if (!terms.length) return true;
        const searchableText = `${item.label} ${item.section} ${item.path}`.toLocaleLowerCase("zh-CN");
        return terms.every((term) => searchableText.includes(term));
      })
      .slice(0, 14);
  }, [query, sections]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex((current) => {
      if (!results.length) return -1;
      return current >= 0 && current < results.length ? current : 0;
    });
  }, [open, results.length]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const activeResult = activeIndex >= 0 ? results[activeIndex] : undefined;
  const hasQuery = Boolean(query.trim());

  function selectResult(path: string) {
    onOpenChange(false);
    onNavigate(path);
  }

  function moveActiveResult(direction: 1 | -1) {
    if (!results.length) return;
    setActiveIndex((current) => {
      if (current < 0) return direction > 0 ? 0 : results.length - 1;
      return (current + direction + results.length) % results.length;
    });
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActiveResult(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveResult(-1);
      return;
    }

    if (event.key === "Enter" && activeResult) {
      event.preventDefault();
      selectResult(activeResult.path);
    }
  }

  return (
    <Dialog
      open={open}
      title="搜索控制台"
      description="按模块、页面名称或路径快速跳转；结果会自动遵循当前账号权限。"
      size="lg"
      initialFocusRef={inputRef}
      returnFocusRef={returnFocusRef}
      onOpenChange={onOpenChange}
      contentClassName="consoleCommandPaletteDialogContent"
    >
      <div className="consoleCommandPalette">
        <label className="consoleCommandSearch" htmlFor={searchId}>
          <span className="consoleCommandSearchHeader">
            <span className="consoleCommandSearchLabel">搜索页面</span>
            <span className="consoleCommandSearchHint" aria-hidden="true">
              <kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 打开
            </span>
          </span>
          <span id={instructionsId} className="consoleCommandInstructions">
            输入关键词后，使用上下方向键选择结果，按回车打开页面。
          </span>
          <Input
            ref={inputRef}
            id={searchId}
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-controls={results.length ? listboxId : undefined}
            aria-describedby={instructionsId}
            aria-expanded={results.length > 0}
            aria-haspopup="listbox"
            aria-activedescendant={activeResult ? `${optionIdPrefix}-${activeIndex}` : undefined}
            startIcon={<Search size={17} aria-hidden="true" />}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder="例如：请求日志、账单、API 密钥"
            autoComplete="off"
            autoCapitalize="off"
            enterKeyHint="go"
            spellCheck={false}
          />
        </label>

        <div className="consoleCommandResultsFrame">
          {results.length ? (
            <div
              id={listboxId}
              className="consoleCommandResults"
              role="listbox"
              aria-label="控制台页面搜索结果"
            >
              {results.map((item, index) => {
                const Icon = item.icon;
                const active = index === activeIndex;
                return (
                  <button
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    id={`${optionIdPrefix}-${index}`}
                    key={item.path}
                    className={active ? "is-active" : undefined}
                    type="button"
                    role="option"
                    aria-selected={active}
                    tabIndex={-1}
                    onPointerEnter={() => setActiveIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectResult(item.path)}
                  >
                    <span className="consoleCommandResultIcon"><Icon size={18} aria-hidden="true" /></span>
                    <span className="consoleCommandResultCopy">
                      <strong>{item.label}</strong>
                      <small>{item.section} · {item.path}</small>
                    </span>
                    <ArrowRight className="consoleCommandResultArrow" size={17} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="consoleCommandEmpty" role="status" aria-live="polite">
              <span className="consoleCommandEmptyIcon" aria-hidden="true"><SearchX size={22} /></span>
              <strong>{hasQuery ? "没有匹配页面" : "暂无可访问页面"}</strong>
              <span>
                {hasQuery
                  ? "尝试输入模块名称、页面名称或更短的关键词。"
                  : "当前账号没有可快速跳转的控制台页面。"}
              </span>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
