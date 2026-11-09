import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bell, CheckCheck, ChevronRight, Clock3, Inbox, X } from "lucide-react";
import { startUiStateSync } from "../../ui/workbenchUiSync";
import { apiGet } from "../../api/http";
import "./FrontstageUpdates.css";

export type FrontstageUpdateMode = "notifications" | "changelog";

type NotificationKind = "announcement" | "release" | "product";

export type FrontstageNotification = {
  id: string;
  kind: NotificationKind;
  title: string;
  summary: string;
  body: string;
  date: string;
  action?: "changelog";
  actionLabel?: string;
};

import { FRONTSTAGE_RELEASE_NOTES, latestReleaseNotificationId, hashText, type ReleaseNote } from "../../../../../contracts/ui/notifications";
export { FRONTSTAGE_RELEASE_NOTES } from "../../../../../contracts/ui/notifications";
export type { ReleaseNote } from "../../../../../contracts/ui/notifications";

function readStoredIds(key: string) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function useFrontstageUpdates(identityKey: string, enabled = true, workspaceId?: string | number | null) {
  const storageKey = `fanjin:frontstage-notifications:${identityKey || "guest"}`;
  const syncRef = useRef<ReturnType<typeof startUiStateSync> | null>(null);
  const [systemNotice, setSystemNotice] = useState("");
  const [readIds, setReadIds] = useState<string[]>(() => readStoredIds(storageKey));

  useEffect(() => {
    setReadIds(readStoredIds(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (!enabled) { setSystemNotice(""); return; }
    let alive = true;
    apiGet<{ notice?: string }>("/developer/config/notice")
      .then((config) => {
        if (alive) setSystemNotice(String(config.notice || "").trim());
      })
      .catch(() => {
        if (alive) setSystemNotice("");
      });
    return () => {
      alive = false;
    };
  }, [enabled, identityKey]);

  useEffect(() => {
    if (!enabled || !workspaceId) return;
    const sync = startUiStateSync((state) => {
      setReadIds(state.readIds);
      try { localStorage.setItem(storageKey, JSON.stringify(state.readIds)); } catch { /* Session state still applies. */ }
      const notice = state.notifications?.find(n => n.kind === "announcement");
      setSystemNotice(notice?.body || "");
    }, readStoredIds(storageKey));
    syncRef.current = sync;
    return () => { sync.stop(); if (syncRef.current === sync) syncRef.current = null; };
  }, [enabled, storageKey, workspaceId]);

  const notifications = useMemo<FrontstageNotification[]>(() => {
    const items: FrontstageNotification[] = [];
    if (systemNotice) {
      items.push({
        id: `announcement:${hashText(systemNotice)}`,
        kind: "announcement",
        title: "平台公告",
        summary: systemNotice.split("\n").find(Boolean)?.slice(0, 72) || "平台发布了新的系统公告。",
        body: systemNotice,
        date: "当前公告",
      });
    }
    const latest = FRONTSTAGE_RELEASE_NOTES[0];
    items.push({
      id: latestReleaseNotificationId,
      kind: "release",
      title: latest.title,
      summary: latest.summary,
      body: `版本：${latest.version}\n${latest.groups.flatMap((group) => group.items).join("\n")}`,
      date: latest.date,
      action: "changelog",
      actionLabel: "查看更新详情",
    });
    return items;
  }, [systemNotice]);

  const persistReadIds = (next: string[]) => {
    const unique = Array.from(new Set(next));
    setReadIds(unique);
    syncRef.current?.patch({ readIds: unique });
    try {
      localStorage.setItem(storageKey, JSON.stringify(unique));
    } catch {
      // 本次会话仍会保留已读状态。
    }
  };

  const markRead = (id: string) => {
    if (readIds.includes(id)) return;
    persistReadIds([...readIds, id]);
  };

  const markAllRead = () => persistReadIds([...readIds, ...notifications.map((item) => item.id)]);
  const markLatestReleaseRead = () => markRead(latestReleaseNotificationId);
  const unreadCount = notifications.filter((item) => !readIds.includes(item.id)).length;

  return {
    notifications,
    releases: FRONTSTAGE_RELEASE_NOTES,
    readIds,
    unreadCount,
    markRead,
    markAllRead,
    markLatestReleaseRead,
  };
}

function notificationKindLabel(kind: NotificationKind) {
  if (kind === "announcement") return "平台公告";
  if (kind === "release") return "产品更新";
  return "系统通知";
}

export function FrontstageUpdatesDrawer({
  mode,
  dark,
  notifications,
  releases,
  readIds,
  onClose,
  onMarkRead,
  onMarkAllRead,
  onOpenChangelog,
}: {
  mode: FrontstageUpdateMode;
  dark: boolean;
  notifications: FrontstageNotification[];
  releases: ReleaseNote[];
  readIds: string[];
  onClose: () => void;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onOpenChangelog: () => void;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => closeRef.current?.focus(), 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"))
        .filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      if (previousFocus && document.contains(previousFocus)) window.setTimeout(() => previousFocus.focus(), 0);
    };
  }, []);

  const visibleNotifications = filter === "unread"
    ? notifications.filter((item) => !readIds.includes(item.id))
    : notifications;
  const unreadCount = notifications.filter((item) => !readIds.includes(item.id)).length;
  const notificationMode = mode === "notifications";

  return createPortal(
    <div
      className={`frontstageUpdatesScrim ${notificationMode ? "frontstageUpdatesScrim--notifications" : ""}`}
      data-theme={dark ? "dark" : "light"}
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        ref={panelRef}
        className={`frontstageUpdatesDrawer ${notificationMode ? "frontstageUpdatesDrawer--notifications" : "frontstageUpdatesDrawer--changelog"}`}
        data-frontstage-notification-center={notificationMode ? "true" : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="frontstageUpdatesHeader">
          {notificationMode ? (
            <div className="frontstageNoticeTitle">
              <h2 id={titleId}>通知</h2>
            </div>
          ) : (
            <div className="frontstageUpdatesHeading">
              <span><Clock3 size={20} /></span>
              <div>
                <h2 id={titleId}>更新日志</h2>
                <p>查看近期功能、体验与稳定性更新</p>
              </div>
            </div>
          )}
          <button ref={closeRef} className="frontstageUpdatesClose" type="button" aria-label={mode === "notifications" ? "关闭通知中心" : "关闭更新日志"} onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        {notificationMode ? (
          <div className="frontstageNoticeLayout">
            <aside className="frontstageNoticeRail" aria-label="通知分类">
              <div className="frontstageNoticeRailNav" role="group" aria-label="通知筛选">
                <button className={filter === "all" ? "active" : ""} type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
                  <Bell size={18} fill="currentColor" />
                  <span>官方通知</span>
                  {unreadCount ? <b>{unreadCount > 99 ? "99+" : unreadCount}</b> : null}
                </button>
                <button className={filter === "unread" ? "active" : ""} type="button" aria-pressed={filter === "unread"} onClick={() => setFilter("unread")}>
                  <Inbox size={18} />
                  <span>未读通知</span>
                </button>
              </div>
              <button className="frontstageNoticeMarkAll" type="button" disabled={!unreadCount} onClick={onMarkAllRead}>
                <CheckCheck size={17} />
                一键已读
              </button>
            </aside>

            <main className="frontstageNoticeMain">
              <header className="frontstageNoticeMainHeader">
                <div>
                  <h3>{filter === "all" ? "官方通知" : "未读通知"}</h3>
                  <p>{filter === "all" ? "平台公告、服务信息与产品更新" : "集中查看尚未阅读的消息"}</p>
                </div>
                <span>{visibleNotifications.length} 条</span>
              </header>

              <div className="frontstageNotificationList" aria-live="polite">
                {visibleNotifications.length ? visibleNotifications.map((item) => {
                  const read = readIds.includes(item.id);
                  const expanded = expandedId === item.id;
                  return (
                    <article className={`frontstageNotificationItem ${read ? "read" : "unread"}`} key={item.id}>
                      <button
                        className="frontstageNotificationSummary"
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => {
                          onMarkRead(item.id);
                          setExpandedId(expanded ? null : item.id);
                        }}
                      >
                        <span className="frontstageNotificationCopy">
                          <span className="frontstageNotificationMeta">
                            <span>{notificationKindLabel(item.kind)}</span>
                            <time>{item.date}</time>
                          </span>
                          <span className="frontstageNotificationTitleLine">
                            <strong>{item.title}</strong>
                            {!read ? <i>未读</i> : null}
                          </span>
                          <small>{item.summary}</small>
                        </span>
                        <span className="frontstageNotificationExpand">
                          {expanded ? "收起" : "展开"}
                          <ChevronRight size={16} className={expanded ? "expanded" : ""} />
                        </span>
                        {!read ? <span className="frontstageUnreadDot" aria-label="未读" /> : null}
                      </button>
                      {expanded ? (
                        <div className="frontstageNotificationDetail">
                          <p>{item.body}</p>
                          {item.action === "changelog" ? (
                            <button type="button" onClick={onOpenChangelog}>{item.actionLabel}<ChevronRight size={16} /></button>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  );
                }) : (
                  <div className="frontstageUpdatesEmpty">
                    <Inbox size={34} strokeWidth={1.5} />
                    <strong>{filter === "unread" ? "没有未读通知" : "暂无通知"}</strong>
                    <span>新的系统公告和产品更新会出现在这里。</span>
                  </div>
                )}
              </div>
            </main>
          </div>
        ) : (
          <div className="frontstageReleaseList">
            {releases.map((release, index) => (
              <article className="frontstageReleaseItem" key={release.id}>
                <header>
                  <div>
                    <span>{release.version}</span>
                    {index === 0 ? <em>最新</em> : null}
                  </div>
                  <time>{release.date}</time>
                </header>
                <h3>{release.title}</h3>
                <p>{release.summary}</p>
                {release.groups.map((group) => (
                  <section key={group.label}>
                    <strong>{group.label}</strong>
                    <ul>{group.items.map((item) => <li key={item}>{item}</li>)}</ul>
                  </section>
                ))}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}
